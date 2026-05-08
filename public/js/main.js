'use strict';

/* ============================================================
   LifeLoop — main.js
   ============================================================ */

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ── Hero incubator: render egg tray ─────────────────────── */
(function renderHeroEggs() {
  const g = document.getElementById('hero-eggs');
  if (!g) return;
  const ns = 'http://www.w3.org/2000/svg';
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 5; col++) {
      const cx = 120 + col * 60;
      const cy = 130 + row * 50;
      const isHighlight = row === 1 && col === 2;
      const ellipse = document.createElementNS(ns, 'ellipse');
      ellipse.setAttribute('cx', cx);
      ellipse.setAttribute('cy', cy);
      ellipse.setAttribute('rx', '14');
      ellipse.setAttribute('ry', '18');
      if (isHighlight) {
        ellipse.setAttribute('fill', 'url(#shell)');
        ellipse.setAttribute('stroke', '#7FA257');
        ellipse.setAttribute('stroke-width', '1');
      } else {
        ellipse.setAttribute('fill', 'rgba(239,235,223,0.06)');
        ellipse.setAttribute('stroke', 'rgba(239,235,223,0.18)');
        ellipse.setAttribute('stroke-width', '0.6');
      }
      g.appendChild(ellipse);
      if (isHighlight) {
        const ring = document.createElementNS(ns, 'circle');
        ring.setAttribute('cx', cx);
        ring.setAttribute('cy', cy);
        ring.setAttribute('r', '22');
        ring.setAttribute('fill', 'none');
        ring.setAttribute('stroke', '#7FA257');
        ring.setAttribute('stroke-width', '0.5');
        ring.setAttribute('stroke-dasharray', '2 2');
        g.appendChild(ring);
        const lead = document.createElementNS(ns, 'line');
        lead.setAttribute('x1', cx + 22);
        lead.setAttribute('y1', cy);
        lead.setAttribute('x2', '380');
        lead.setAttribute('y2', '200');
        lead.setAttribute('stroke', '#7FA257');
        lead.setAttribute('stroke-width', '0.5');
        g.appendChild(lead);
        const tip = document.createElementNS(ns, 'circle');
        tip.setAttribute('cx', '380');
        tip.setAttribute('cy', '200');
        tip.setAttribute('r', '2');
        tip.setAttribute('fill', '#7FA257');
        g.appendChild(tip);
      }
    }
  }
})();

/* ── Solution cutaway: render trays ──────────────────────── */
(function renderCutawayTrays() {
  const g = document.getElementById('cutaway-trays');
  if (!g) return;
  const ns = 'http://www.w3.org/2000/svg';
  for (let layer = 0; layer < 3; layer++) {
    const y = 120 + layer * 70;
    const baseline = document.createElementNS(ns, 'line');
    baseline.setAttribute('x1', '60');
    baseline.setAttribute('y1', y + 30);
    baseline.setAttribute('x2', '300');
    baseline.setAttribute('y2', y + 30);
    baseline.setAttribute('stroke', '#383E33');
    baseline.setAttribute('stroke-width', '0.6');
    g.appendChild(baseline);
    for (let i = 0; i < 7; i++) {
      const e = document.createElementNS(ns, 'ellipse');
      e.setAttribute('cx', 80 + i * 33);
      e.setAttribute('cy', y + 22);
      e.setAttribute('rx', '9');
      e.setAttribute('ry', '13');
      e.setAttribute('fill', 'rgba(239,235,223,0.05)');
      e.setAttribute('stroke', 'rgba(239,235,223,0.22)');
      e.setAttribute('stroke-width', '0.6');
      g.appendChild(e);
    }
    const lbl = document.createElementNS(ns, 'text');
    lbl.setAttribute('x', '62');
    lbl.setAttribute('y', y + 5);
    lbl.setAttribute('font-family', 'IBM Plex Mono');
    lbl.setAttribute('font-size', '7');
    lbl.setAttribute('fill', '#8A8678');
    lbl.setAttribute('letter-spacing', '0.1em');
    lbl.textContent = `TRAY ${layer + 1}`;
    g.appendChild(lbl);
  }
})();

/* ── Mobile nav toggle ──────────────────────────────────── */
(function initNavToggle() {
  const toggle = $('#nav-toggle');
  const links  = $('#nav-links');
  if (!toggle || !links) return;

  toggle.addEventListener('click', () => {
    const open = links.classList.toggle('open');
    toggle.setAttribute('aria-expanded', String(open));
  });

  $$('#nav-links a').forEach(a => {
    a.addEventListener('click', () => {
      links.classList.remove('open');
      toggle.setAttribute('aria-expanded', 'false');
    });
  });
})();

/* ── Active section highlight in nav ────────────────────── */
(function initNavActive() {
  const sections = $$('section[id]');
  const links = $$('#nav-links a[href^="#"]');
  if (!sections.length || !links.length) return;

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(({ target, isIntersecting }) => {
      if (!isIntersecting) return;
      const id = target.getAttribute('id');
      links.forEach(l => l.classList.toggle('active', l.getAttribute('href') === `#${id}`));
    });
  }, { threshold: 0.3, rootMargin: '-80px 0px -55% 0px' });

  sections.forEach(s => observer.observe(s));
})();

/* ── Reveal on scroll (with light staggering) ──────────── */
(function initReveal() {
  const staggerGroups = ['.problem-rows', '.steps', '.journey', '.join-grid', '.capability-list'];
  staggerGroups.forEach(sel => {
    const group = $(sel);
    if (!group) return;
    [...group.children]
      .filter(c => c.classList.contains('reveal'))
      .forEach((c, i) => c.style.setProperty('--stagger-delay', `${i * 0.08}s`));
  });

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(({ target, isIntersecting }) => {
      if (!isIntersecting) return;
      target.classList.add('visible');
      observer.unobserve(target);
    });
  }, { threshold: 0.1, rootMargin: '0px 0px -40px 0px' });

  $$('.reveal').forEach(el => observer.observe(el));
})();

/* ── Hero stat counters ────────────────────────────────── */
(function initCounters() {
  const counters = $$('[data-counter]');
  if (!counters.length) return;

  function animate(el, target, duration, suffix) {
    if (reduceMotion) {
      el.textContent = target + suffix;
      return;
    }
    const start = performance.now();
    function tick(now) {
      const t = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      const value = Math.round(target * eased);
      el.textContent = value + suffix;
      if (t < 1) requestAnimationFrame(tick);
      else el.textContent = target + suffix;
    }
    requestAnimationFrame(tick);
  }

  let started = false;
  const observer = new IntersectionObserver(([entry]) => {
    if (!entry.isIntersecting || started) return;
    started = true;
    observer.disconnect();
    counters.forEach(el => {
      const target = Number(el.dataset.target);
      const suffix = el.dataset.suffix || '';
      const duration = target === 0 ? 600 : (target >= 100 ? 1500 : 1100);
      animate(el, target, duration, suffix);
    });
  }, { threshold: 0.5 });

  observer.observe(counters[0].closest('.hero__stats') || counters[0]);
})();

/* ── Hub progress bars ─────────────────────────────────── */
(function initHubBars() {
  const hub = $('#hub-mock');
  const bars = $$('.hub__unit-bar-fill', hub);
  if (!hub || !bars.length) return;

  let played = false;
  const observer = new IntersectionObserver(([entry]) => {
    if (!entry.isIntersecting || played) return;
    played = true;
    observer.disconnect();
    bars.forEach((bar, i) => {
      const w = bar.dataset.width || '0%';
      setTimeout(() => { bar.style.width = w; }, i * 180);
    });
  }, { threshold: 0.3 });
  observer.observe(hub);
})();

/* ── Cycle phase reveal + events ───────────────────────── */
(function initCycle() {
  const cycle = $('#cycle');
  if (!cycle) return;
  const phases = $$('.cycle__phase', cycle);
  const events = $$('.cycle__event', cycle);

  let played = false;
  const observer = new IntersectionObserver(([entry]) => {
    if (!entry.isIntersecting || played) return;
    played = true;
    observer.disconnect();
    phases.forEach((p, i) => setTimeout(() => p.classList.add('visible'), i * 160));
    events.forEach((e, i) => setTimeout(() => e.classList.add('visible'), 480 + i * 140));
  }, { threshold: 0.35 });
  observer.observe(cycle);
})();

/* ── Hero canvas: subtle drifting field ────────────────── */
(function initCanvas() {
  const canvas = $('#hero-canvas');
  if (!canvas || reduceMotion) return;
  const ctx = canvas.getContext('2d');

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width  = canvas.offsetWidth  * dpr;
    canvas.height = canvas.offsetHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function sizeFromHero() {
    const hero = canvas.parentElement;
    canvas.style.width  = hero.offsetWidth + 'px';
    canvas.style.height = hero.offsetHeight + 'px';
    resize();
  }
  sizeFromHero();
  window.addEventListener('resize', sizeFromHero, { passive: true });

  const W = () => canvas.offsetWidth;
  const H = () => canvas.offsetHeight;

  const COUNT = Math.min(50, Math.floor(W() / 24));

  class Particle {
    constructor(scatter) { this.init(scatter); }
    init(scatter) {
      this.x = Math.random() * W();
      this.y = scatter ? Math.random() * H() : H() + 20;
      this.vy = -(Math.random() * 0.25 + 0.08);
      this.vx = (Math.random() - 0.5) * 0.15;
      this.r = Math.random() * 1.6 + 0.6;
      this.phase = Math.random() * Math.PI * 2;
      this.speed = Math.random() * 0.012 + 0.006;
    }
    update() {
      this.x += this.vx;
      this.y += this.vy;
      this.phase += this.speed;
      if (this.y < -10) this.init(false);
    }
    draw() {
      ctx.save();
      ctx.globalAlpha = (Math.sin(this.phase) * 0.18 + 0.22);
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.r, 0, Math.PI * 2);
      ctx.fillStyle = '#7FA257';
      ctx.fill();
      ctx.restore();
    }
  }

  const particles = Array.from({ length: COUNT }, () => new Particle(true));

  function frame() {
    ctx.clearRect(0, 0, W(), H());
    const grd = ctx.createRadialGradient(W() * 0.6, H() * 0.4, 0, W() * 0.6, H() * 0.4, W() * 0.55);
    grd.addColorStop(0,   'rgba(127,162,87,0.05)');
    grd.addColorStop(0.5, 'rgba(127,162,87,0.02)');
    grd.addColorStop(1,   'transparent');
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, W(), H());

    for (let i = 0; i < particles.length; i++) {
      for (let j = i + 1; j < particles.length; j++) {
        const dx = particles[i].x - particles[j].x;
        const dy = particles[i].y - particles[j].y;
        const d = Math.hypot(dx, dy);
        if (d < 110) {
          ctx.beginPath();
          ctx.moveTo(particles[i].x, particles[i].y);
          ctx.lineTo(particles[j].x, particles[j].y);
          ctx.strokeStyle = `rgba(127,162,87,${(1 - d / 110) * 0.04})`;
          ctx.lineWidth = 0.6;
          ctx.stroke();
        }
      }
    }
    particles.forEach(p => { p.update(); p.draw(); });
    requestAnimationFrame(frame);
  }
  frame();
})();

/* ── Contact form ──────────────────────────────────────── */
(function initForm() {
  const form   = $('#contact-form');
  const status = $('#form-status');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    status.className = 'form-status';
    status.textContent = '';

    const btn = form.querySelector('button[type="submit"]');
    const orig = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = 'Sending…';

    const payload = Object.fromEntries(new FormData(form).entries());

    try {
      const res = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        status.className = 'form-status success';
        status.textContent = "MESSAGE SENT · WE'LL BE IN TOUCH SOON";
        form.reset();
      } else {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Server error');
      }
    } catch (err) {
      status.className = 'form-status error';
      status.textContent = err.message.includes('Server error')
        ? 'SOMETHING WENT WRONG · TRY AGAIN SHORTLY'
        : err.message.toUpperCase();
    } finally {
      btn.disabled = false;
      btn.innerHTML = orig;
    }
  });
})();
