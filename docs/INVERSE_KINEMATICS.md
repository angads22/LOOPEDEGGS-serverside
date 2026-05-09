# Inverse Kinematics — LifeLoop Camera Head

This document describes the math you need to point a 2-DOF (pan/tilt)
camera head at an arbitrary 3-D target inside the incubator. It covers
the closed-form solution, the extension to a tilt axis offset from the
pan axis, the conversion from a pixel the user clicked on to a 3-D
target, and how the result maps to servo PWM.

> **TL;DR** — for a 2-DOF camera head you do *not* need a numerical IK
> solver. Each axis has a single, closed-form solution. Two `atan2`
> calls and you're done.

---

## 1. Coordinate frame

Place the origin at the **pan axis** (the vertical axis the camera
rotates around). Right-handed frame:

```
+x  → forward (the direction the head looks at when pan = 0, tilt = 0)
+y  → left
+z  → up
```

Joint conventions:

| Joint | Symbol | Range  | Direction                              |
| ----- | ------ | -----  | -------------------------------------- |
| pan   | θ_pan  | ±90°   | +θ rotates camera toward +y (left)     |
| tilt  | θ_tilt | ±60°   | +θ rotates camera toward +z (up)       |

Both ranges are mechanical limits; clamp before sending to servos.

---

## 2. Forward kinematics (sanity check)

Given joint angles `(θ_pan, θ_tilt)` and a camera that looks down the
local `+x` axis, the camera's pointing vector in world frame is:

```
look_x =  cos(θ_tilt) · cos(θ_pan)
look_y =  cos(θ_tilt) · sin(θ_pan)
look_z =  sin(θ_tilt)
```

You'll use this to **draw the target reticle** on the live feed and to
verify your servo wiring (drive `(0, 0)` and the camera should look
straight at +x; drive `(90°, 0)` and it should look at +y).

---

## 3. Inverse kinematics — ideal case

If the pan and tilt axes intersect at the camera's optical center
(common for hobby pan/tilt brackets), and the target point is
`T = (t_x, t_y, t_z)` in the head frame:

```
θ_pan  = atan2(t_y, t_x)
θ_tilt = atan2(t_z, hypot(t_x, t_y))   // hypot = sqrt(x² + y²)
```

That's the entire IK. **Pan first, then tilt** — that order matters
because tilt is applied after pan in the kinematic chain.

```js
// Reference implementation (radians).
function ikPanTilt({ x, y, z }) {
  const pan  = Math.atan2(y, x);
  const tilt = Math.atan2(z, Math.hypot(x, y));
  return { pan, tilt };
}
```

### Why no Jacobian / no iteration?

The wrist (camera) has 3 rotational DOFs we'd like to control (yaw,
pitch, roll), but a pan/tilt head only has 2 actuated DOFs. We give up
roll. The remaining 2 are decoupled along orthogonal axes, so each one
solves analytically. Iterative solvers (CCD, FABRIK, damped least
squares) only become necessary when:

- Joints are **not** along world axes (e.g. an arm with offsets).
- The DOF count exceeds the task-space dimension (a 6-DOF arm reaching
  for a 3-D point is over-constrained → null space).
- The mechanism has **closed loops** (parallel/delta robots).

None of that applies here.

---

## 4. Real-world correction: tilt axis offset

Most cheap pan/tilt brackets are *not* perfectly co-axial. The tilt
servo sits some distance `d` above the pan servo, so when pan rotates,
the camera also translates around a circle of radius `d`. Ignoring this
is fine for distant targets but causes parallax error for close-up
inspection (the usual case in an incubator).

Let `d` = vertical offset from pan axis to tilt axis (meters).

```
// Target point T in head frame.
// 1. Solve pan by projecting onto the x-y plane — same as before.
θ_pan = atan2(T.y, T.x)

// 2. Tilt is solved in the local frame *after* pan, where the tilt
//    axis is now at (0, 0, d). The vector from the tilt axis to the
//    target in that frame is:
r_xy = hypot(T.x, T.y)        // distance from pan axis in x-y plane
dz   = T.z - d                // height above the tilt axis
θ_tilt = atan2(dz, r_xy)
```

In code:

```js
function ikPanTilt({ x, y, z }, { tiltAxisOffset = 0 } = {}) {
  const pan  = Math.atan2(y, x);
  const dz   = z - tiltAxisOffset;
  const tilt = Math.atan2(dz, Math.hypot(x, y));
  return { pan, tilt };
}
```

For a typical SG90 pan/tilt bracket `d ≈ 0.025 m`. Measure yours and
put it in `device/config.json` (see §7).

---

## 5. From a clicked pixel to a 3-D target

When the user clicks on the live feed, you have a pixel `(u, v)` and
need a 3-D point to look at. With one camera you can't recover depth,
but you don't need to — you only need a **direction**, and pan/tilt is
direction-only anyway.

Given the camera's intrinsic matrix `K` (focal lengths `fx, fy` and
principal point `cx, cy`), the ray through pixel `(u, v)` in the
**camera frame** is:

```
ray_cam = normalize( ( (u - cx) / fx,  (v - cy) / fy,  1 ) )
                      ─────────────   ─────────────   ─
                          right            down       forward
```

Note the camera frame is `+x right, +y down, +z forward` (OpenCV
convention). Convert it to the head frame `+x forward, +y left, +z up`:

```
ray_head = ( ray_cam.z, -ray_cam.x, -ray_cam.y )
```

Then run the IK on `ray_head` directly (you can treat it as a target
"at infinity" — magnitudes don't matter, only the direction):

```js
const T = pixelToHeadRay(u, v, K);   // 3-vector
const { pan, tilt } = ikPanTilt(T);

// These are *deltas* relative to the current head pose. Add them.
const targetPan  = currentPan  + pan;
const targetTilt = currentTilt + tilt;
```

### Calibrating `K`

For a quick start, approximate:

```
fx = fy = (image_width / 2) / tan(hFOV / 2)
cx = image_width  / 2
cy = image_height / 2
```

The Pi Camera Module 3 wide has `hFOV ≈ 102°`, the standard module is
`≈ 66°`. For real accuracy, run a checkerboard calibration with OpenCV
once and save `K` to `device/config.json`.

---

## 6. Joint limits, smoothing, deadband

Raw IK output goes through three filters before it ever reaches a
servo:

```js
// 1. Clamp to mechanical limits.
pan  = clamp(pan,  -90°, +90°)
tilt = clamp(tilt, -60°, +60°)

// 2. Slew-rate limit so the servos don't snap.
const maxRadPerSec = 3.0;                           // ~170°/s
pan  = approach(currentPan,  pan,  maxRadPerSec * dt)
tilt = approach(currentTilt, tilt, maxRadPerSec * dt)

// 3. Deadband — ignore sub-pixel jitter, save servo wear.
if (abs(pan  - currentPan)  < 0.5°) pan  = currentPan
if (abs(tilt - currentTilt) < 0.5°) tilt = currentTilt
```

A simple linear approach is fine. If you want buttery motion, use a
critically-damped second-order filter (a "smoothing spring"); look up
"Game Programming Gems 4 — critically damped spring" — about 8 lines
of code.

---

## 7. Mapping radians → servo PWM

Hobby servos accept a 50 Hz PWM signal where the pulse width encodes
the angle:

```
1.0 ms  →  -90°   (full one way)
1.5 ms  →    0°   (centre)
2.0 ms  →  +90°   (full the other way)
```

So:

```js
function radToMicroseconds(rad, { centreUs = 1500, usPerRad = 318.31 } = {}) {
  // 318.31 µs/rad ≈ (2000 - 1000) / π   (1 ms full swing over 180°)
  return centreUs + rad * usPerRad;
}
```

Cheap servos lie about their range — measure yours. The JSON config
the device reads should look like:

```json
{
  "tiltAxisOffset_m": 0.025,
  "pan":  { "channel": 0, "centreUs": 1500, "minUs": 600, "maxUs": 2400, "invert": false },
  "tilt": { "channel": 1, "centreUs": 1500, "minUs": 800, "maxUs": 2200, "invert": true  },
  "camera": {
    "width": 1280, "height": 720, "fov_h_deg": 66
  }
}
```

`invert` is the cheap way to fix "I wired the servo backwards" — the
device just negates the angle before computing PWM.

---

## 8. End-to-end pipeline

```
                    ┌────────────────────────────────────────────┐
   user clicks      │ Browser (public/js/inspect.js)            │
   on pixel ────────►   1. capture (u, v, image_w, image_h)     │
                    │   2. POST /api/hub/incubators/:id/look   ─┼─┐
                    └────────────────────────────────────────────┘ │
                                                                   ▼
                    ┌────────────────────────────────────────────┐
                    │ Hub server (server.js)                     │
                    │   3. validate, throttle, ws.send({         │
                    │        type:"head_target_pixel", u, v, ...│
                    │      }) to that device                     │
                    └─────────────────┬──────────────────────────┘
                                      │
                                      ▼  WebSocket
                    ┌────────────────────────────────────────────┐
                    │ Device (Pi)  device/lifeloop_device.py     │
                    │   4. pixelToHeadRay(u, v, K)               │
                    │   5. ikPanTilt(...)        ← §3/§4         │
                    │   6. clamp + slew + deadband ← §6          │
                    │   7. radToMicroseconds      ← §7           │
                    │   8. PCA9685.set_pulse(channel, us)        │
                    └────────────────────────────────────────────┘
```

The hub never does IK — it's just a relay. The IK lives on the device
because the device is the only thing that knows the calibration `K`,
the offset `d`, and the actual current servo position.

---

## 9. When you outgrow this

If/when you upgrade to:

- **3-DOF (add roll)** — same idea, three closed-form atan2 calls if
  the axes are orthogonal and intersect.
- **Camera mounted on an arm** — now the pan axis isn't co-located
  with the camera. Use a 4×4 transform to express `T` in the head
  frame, then run §3/§4 unchanged.
- **Track a moving egg** — wrap §3 in a control loop with a target
  velocity feedforward and a small PID on pixel error. Keep the IK
  closed-form; the loop just updates `T` at 30 Hz.

You will *not* need a real IK solver until you put a manipulator
(grabber) on the head and need to also position its tip — at which
point `ikpy`, `pinocchio`, or a hand-rolled damped-least-squares
solver makes sense.
