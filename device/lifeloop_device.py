#!/usr/bin/env python3
# =============================================================================
#  LifeLoop device-side agent — reference implementation
#
#  Runs on the Pi (or any Linux SBC) inside an incubator. Responsibilities:
#    1. Register with the hub over REST.
#    2. Open a WebSocket back to the hub with `?deviceId=<id>` so the hub
#       can push commands.
#    3. Translate `head_target_*` commands to servo motion (this is where
#       the IK lives — see docs/INVERSE_KINEMATICS.md).
#    4. Stream MJPEG from the camera; the hub proxies it to browsers.
#    5. Push telemetry on a schedule.
#
#  Hardware backends are pluggable — the ServoDriver / Camera classes at
#  the top can be swapped for whatever you actually wired up. A
#  software-only "FakeServoDriver" is included so this runs on a laptop
#  with no hardware attached.
#
#  Dependencies (Pi):
#      python3 -m pip install websockets requests
#      # plus, if using PCA9685:    adafruit-circuitpython-pca9685
#      # plus, if using picamera2:  picamera2  (apt: python3-picamera2)
#
#  Run:
#      python3 lifeloop_device.py --hub https://loopedeggs.ca \
#                                 --device-id incubator-01 \
#                                 --stream-url http://192.168.1.42:8080/stream
# =============================================================================

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import math
import os
import signal
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import requests
import websockets

log = logging.getLogger("lifeloop")

# ─── Config ──────────────────────────────────────────────────────────────────

@dataclass
class AxisConfig:
    channel:   int   = 0
    centre_us: int   = 1500
    min_us:    int   = 600
    max_us:    int   = 2400
    invert:    bool  = False
    # Mechanical limits (radians) — clamp here BEFORE converting to PWM.
    min_rad:   float = -math.pi / 2
    max_rad:   float = +math.pi / 2

@dataclass
class CameraConfig:
    width:    int   = 1280
    height:   int   =  720
    fov_h_deg: float = 66.0          # Pi Camera v2 standard

@dataclass
class DeviceConfig:
    tilt_axis_offset_m: float = 0.025
    pan:    AxisConfig  = field(default_factory=lambda: AxisConfig(channel=0))
    tilt:   AxisConfig  = field(default_factory=lambda: AxisConfig(channel=1, min_rad=-math.pi/3, max_rad=+math.pi/3))
    camera: CameraConfig = field(default_factory=CameraConfig)

    @classmethod
    def load(cls, path: Optional[Path]) -> "DeviceConfig":
        if not path or not path.exists():
            return cls()
        data = json.loads(path.read_text())
        cfg = cls()
        cfg.tilt_axis_offset_m = data.get("tiltAxisOffset_m", cfg.tilt_axis_offset_m)
        for axis_name in ("pan", "tilt"):
            axis_data = data.get(axis_name, {})
            axis = getattr(cfg, axis_name)
            for key in ("channel", "centreUs", "minUs", "maxUs", "invert"):
                if key in axis_data:
                    setattr(axis, key.replace("Us", "_us").replace("centreUs", "centre_us")
                                     if key.endswith("Us") else key, axis_data[key])
        cam = data.get("camera", {})
        cfg.camera.width  = cam.get("width",  cfg.camera.width)
        cfg.camera.height = cam.get("height", cfg.camera.height)
        cfg.camera.fov_h_deg = cam.get("fov_h_deg", cfg.camera.fov_h_deg)
        return cfg


# ─── Inverse kinematics (closed-form, 2-DOF) ────────────────────────────────
#
# See docs/INVERSE_KINEMATICS.md for the derivation. Two cases:
#   1. Pure direction (click-to-look): vector → angles, no offset correction.
#   2. 3-D point with the tilt axis offset above the pan axis.

def ik_pan_tilt_direction(x: float, y: float, z: float) -> tuple[float, float]:
    """Point the camera at the *direction* (x, y, z). Magnitude ignored."""
    pan  = math.atan2(y, x)
    tilt = math.atan2(z, math.hypot(x, y))
    return pan, tilt

def ik_pan_tilt_point(x: float, y: float, z: float, tilt_offset_m: float = 0.0) -> tuple[float, float]:
    """Point at a 3-D world-frame target, accounting for tilt-axis offset `d`."""
    pan  = math.atan2(y, x)
    tilt = math.atan2(z - tilt_offset_m, math.hypot(x, y))
    return pan, tilt

def pixel_to_head_ray(u: float, v: float, w: int, h: int, fov_h_deg: float) -> tuple[float, float, float]:
    """Convert pixel (u, v) in a (w × h) frame to a unit ray in the head frame.

    Camera frame:  +x right, +y down, +z forward  (OpenCV).
    Head frame:    +x forward, +y left, +z up.
    """
    fov = math.radians(fov_h_deg)
    fx  = (w / 2) / math.tan(fov / 2)
    fy  = fx                                          # square pixels
    cx, cy = w / 2, h / 2

    cam_x = (u - cx) / fx
    cam_y = (v - cy) / fy
    cam_z = 1.0
    n = math.sqrt(cam_x * cam_x + cam_y * cam_y + cam_z * cam_z)
    cam_x, cam_y, cam_z = cam_x / n, cam_y / n, cam_z / n

    # Camera → head frame.
    return (cam_z, -cam_x, -cam_y)


# ─── Servo drivers ──────────────────────────────────────────────────────────

class ServoDriver:
    """Interface only. Implementations below."""
    def set_pulse_us(self, channel: int, us: int) -> None: ...
    def close(self) -> None: ...

class FakeServoDriver(ServoDriver):
    """No hardware — just logs. Use this on a laptop / in CI."""
    def set_pulse_us(self, channel: int, us: int) -> None:
        log.info("servo[%d] ← %d µs (FAKE)", channel, us)
    def close(self) -> None: pass

class PCA9685Driver(ServoDriver):
    """Adafruit PCA9685 over I2C. Recommended for production."""
    def __init__(self, freq_hz: int = 50, address: int = 0x40) -> None:
        # Imports are local so the script still runs on machines without
        # the I2C / circuitpython stack installed.
        import board, busio                          # type: ignore
        from adafruit_pca9685 import PCA9685         # type: ignore
        self._pca = PCA9685(busio.I2C(board.SCL, board.SDA), address=address)
        self._pca.frequency = freq_hz
        self._period_us = 1_000_000 / freq_hz

    def set_pulse_us(self, channel: int, us: int) -> None:
        # PCA9685 takes a 16-bit duty cycle.
        duty = int((us / self._period_us) * 0xFFFF)
        duty = max(0, min(0xFFFF, duty))
        self._pca.channels[channel].duty_cycle = duty

    def close(self) -> None:
        self._pca.deinit()


# ─── Head controller ────────────────────────────────────────────────────────

class HeadController:
    """Wraps a ServoDriver with limits, slew-rate, and rad → µs conversion."""

    SLEW_RAD_PER_S = 3.0     # ~170°/s — keep slow servos sane
    DEADBAND_RAD   = math.radians(0.5)

    def __init__(self, driver: ServoDriver, cfg: DeviceConfig) -> None:
        self.driver = driver
        self.cfg    = cfg
        self.pan    = 0.0
        self.tilt   = 0.0
        self._last  = time.monotonic()

    def _rad_to_us(self, rad: float, axis: AxisConfig) -> int:
        if axis.invert:
            rad = -rad
        # Linear map: -π/2 → min_us, 0 → centre_us, +π/2 → max_us.
        if rad >= 0:
            us = axis.centre_us + rad * (axis.max_us - axis.centre_us) / (math.pi / 2)
        else:
            us = axis.centre_us + rad * (axis.centre_us - axis.min_us) / (math.pi / 2)
        return int(round(max(axis.min_us, min(axis.max_us, us))))

    def _approach(self, current: float, target: float, max_step: float) -> float:
        delta = target - current
        if abs(delta) <= max_step: return target
        return current + math.copysign(max_step, delta)

    def move_to(self, pan_target: float, tilt_target: float) -> None:
        # Clamp to mechanical limits.
        pan_target  = max(self.cfg.pan.min_rad,  min(self.cfg.pan.max_rad,  pan_target))
        tilt_target = max(self.cfg.tilt.min_rad, min(self.cfg.tilt.max_rad, tilt_target))

        now = time.monotonic()
        dt  = max(0.001, now - self._last)
        self._last = now
        max_step = self.SLEW_RAD_PER_S * dt

        new_pan  = self._approach(self.pan,  pan_target,  max_step)
        new_tilt = self._approach(self.tilt, tilt_target, max_step)

        if abs(new_pan  - self.pan)  > self.DEADBAND_RAD:
            self.driver.set_pulse_us(self.cfg.pan.channel,  self._rad_to_us(new_pan,  self.cfg.pan))
            self.pan = new_pan
        if abs(new_tilt - self.tilt) > self.DEADBAND_RAD:
            self.driver.set_pulse_us(self.cfg.tilt.channel, self._rad_to_us(new_tilt, self.cfg.tilt))
            self.tilt = new_tilt

    def nudge(self, d_pan: float, d_tilt: float) -> None:
        self.move_to(self.pan + d_pan, self.tilt + d_tilt)

    def look_at_pixel(self, u: float, v: float, w: int, h: int, *, relative: bool) -> None:
        ray = pixel_to_head_ray(u, v, w, h, self.cfg.camera.fov_h_deg)
        d_pan, d_tilt = ik_pan_tilt_direction(*ray)
        if relative:
            self.nudge(d_pan, d_tilt)
        else:
            self.move_to(d_pan, d_tilt)


# ─── Hub agent (REST + WebSocket) ───────────────────────────────────────────

class HubAgent:
    def __init__(self, hub_url: str, device_id: str, name: str,
                 stream_url: Optional[str], head: HeadController) -> None:
        self.hub_url    = hub_url.rstrip("/")
        self.device_id  = device_id
        self.name       = name
        self.stream_url = stream_url
        self.head       = head
        self._stop      = asyncio.Event()

    def stop(self) -> None: self._stop.set()

    def register(self) -> None:
        log.info("registering with %s", self.hub_url)
        r = requests.post(f"{self.hub_url}/api/hub/incubators/register", json={
            "deviceId":     self.device_id,
            "name":         self.name,
            "streamUrl":    self.stream_url,
            "capabilities": ["camera", "pan", "tilt"] if self.stream_url else ["pan", "tilt"],
        }, timeout=10)
        r.raise_for_status()

    async def run(self) -> None:
        ws_scheme = "wss" if self.hub_url.startswith("https") else "ws"
        host = self.hub_url.split("://", 1)[1]
        url  = f"{ws_scheme}://{host}/ws?deviceId={self.device_id}"

        backoff = 1.0
        while not self._stop.is_set():
            try:
                async with websockets.connect(url, ping_interval=20, ping_timeout=20) as ws:
                    log.info("ws connected")
                    backoff = 1.0
                    pose_task = asyncio.create_task(self._pose_loop(ws))
                    try:
                        async for raw in ws:
                            await self._handle(raw)
                    finally:
                        pose_task.cancel()
            except (OSError, websockets.WebSocketException) as e:
                log.warning("ws error: %s — retry in %.1fs", e, backoff)
                try:
                    await asyncio.wait_for(self._stop.wait(), timeout=backoff)
                except asyncio.TimeoutError:
                    pass
                backoff = min(backoff * 2, 30.0)

    async def _pose_loop(self, ws) -> None:
        while True:
            await ws.send(json.dumps({
                "type": "head_pose",
                "pan":  self.head.pan,
                "tilt": self.head.tilt,
            }))
            await asyncio.sleep(0.5)

    async def _handle(self, raw: str) -> None:
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            return

        t = msg.get("type")
        if t == "head_target_pixel":
            self.head.look_at_pixel(
                u=float(msg["u"]), v=float(msg["v"]),
                w=int(msg["frameWidth"]), h=int(msg["frameHeight"]),
                relative=bool(msg.get("relative", True)),
            )
        elif t == "head_target_angle":
            pan  = float(msg["pan"])
            tilt = float(msg["tilt"])
            if msg.get("mode") == "relative":
                self.head.nudge(pan, tilt)
            else:
                self.head.move_to(pan, tilt)
        else:
            log.debug("unhandled message: %s", t)


# ─── Entrypoint ─────────────────────────────────────────────────────────────

def main() -> None:
    p = argparse.ArgumentParser(description="LifeLoop device-side agent")
    p.add_argument("--hub",        default=os.environ.get("LIFELOOP_HUB", "http://localhost:3000"))
    p.add_argument("--device-id",  default=os.environ.get("LIFELOOP_DEVICE_ID", "dev-laptop"))
    p.add_argument("--name",       default=os.environ.get("LIFELOOP_NAME", "LifeLoop Unit"))
    p.add_argument("--stream-url", default=os.environ.get("LIFELOOP_STREAM_URL"))
    p.add_argument("--config",     type=Path, default=Path("config.json"))
    p.add_argument("--driver",     choices=["fake", "pca9685"], default="fake")
    p.add_argument("--verbose", "-v", action="store_true")
    args = p.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )

    cfg = DeviceConfig.load(args.config)
    driver: ServoDriver = PCA9685Driver() if args.driver == "pca9685" else FakeServoDriver()
    head = HeadController(driver, cfg)

    agent = HubAgent(args.hub, args.device_id, args.name, args.stream_url, head)
    agent.register()

    loop = asyncio.new_event_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, agent.stop)

    try:
        loop.run_until_complete(agent.run())
    finally:
        driver.close()
        loop.close()


if __name__ == "__main__":
    main()
