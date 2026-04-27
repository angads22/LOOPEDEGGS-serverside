'use strict';

// ── Navbar ────────────────────────────────────────────────────
const navbar = document.getElementById('navbar');
const navToggle = document.getElementById('nav-toggle');
const navLinks = document.getElementById('nav-links');

window.addEventListener('scroll', () => {
  navbar.classList.toggle('scrolled', window.scrollY > 40);
}, { passive: true });

navToggle.addEventListener('click', () => {
  const open = navLinks.classList.toggle('open');
  navToggle.setAttribute('aria-expanded', String(open));
});

navLinks.querySelectorAll('a').forEach(a => {
  a.addEventListener('click', () => {
    navLinks.classList.remove('open');
    navToggle.setAttribute('aria-expanded', 'false');
  });
});

// ── Scroll Reveal ─────────────────────────────────────────────
const revealObserver = new IntersectionObserver((entries) => {
  entries.forEach(({ target, isIntersecting }) => {
    if (!isIntersecting) return;
    target.classList.add('visible');
    revealObserver.unobserve(target);
  });
}, { threshold: 0.08, rootMargin: '0px 0px -40px 0px' });

document.querySelectorAll('.reveal').forEach(el => revealObserver.observe(el));

// ── Hero Canvas ───────────────────────────────────────────────
(function initCanvas() {
  const canvas = document.getElementById('hero-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  function resize() {
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  resize();
  window.addEventListener('resize', resize, { passive: true });

  const COUNT = Math.min(55, Math.floor(window.innerWidth / 22));

  class Egg {
    constructor(scatter) {
      this.init(scatter);
    }
    init(scatter) {
      this.x = Math.random() * canvas.width;
      this.y = scatter ? Math.random() * canvas.height : canvas.height + 15;
      this.vy = -(Math.random() * 0.45 + 0.18);
      this.vx = (Math.random() - 0.5) * 0.25;
      this.r  = Math.random() * 3.5 + 1.5;
      this.phase = Math.random() * Math.PI * 2;
      this.alpha = 0;
    }
    update() {
      this.x += this.vx;
      this.y += this.vy;
      this.phase += 0.018;
      this.alpha = Math.sin(this.phase) * 0.18 + 0.15;
      if (this.y < -15) this.init(false);
    }
    draw() {
      ctx.save();
      ctx.globalAlpha = Math.max(0, this.alpha);
      ctx.beginPath();
      ctx.ellipse(this.x, this.y, this.r * 0.68, this.r, 0, 0, Math.PI * 2);
      ctx.fillStyle = '#4FAE4F';
      ctx.fill();
      ctx.restore();
    }
  }

  const eggs = Array.from({ length: COUNT }, () => new Egg(true));

  function frame() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Ambient radial glow behind hero content
    const grd = ctx.createRadialGradient(
      canvas.width * .5, canvas.height * .42, 0,
      canvas.width * .5, canvas.height * .42, canvas.width * .6
    );
    grd.addColorStop(0,   'rgba(79,174,79,0.06)');
    grd.addColorStop(0.5, 'rgba(47,125,50,0.03)');
    grd.addColorStop(1,   'transparent');
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    eggs.forEach(e => { e.update(); e.draw(); });
    requestAnimationFrame(frame);
  }
  frame();
})();

// ── Contact Form ──────────────────────────────────────────────
(function initForm() {
  const form   = document.getElementById('contact-form');
  const status = document.getElementById('form-status');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    status.className = 'form-status';
    status.textContent = '';

    const btn  = form.querySelector('button[type="submit"]');
    const orig = btn.textContent;
    btn.textContent = 'Sending…';
    btn.disabled = true;

    const payload = Object.fromEntries(new FormData(form).entries());

    try {
      const res = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        status.className = 'form-status success';
        status.textContent = "Message sent! We'll be in touch soon.";
        form.reset();
      } else {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Server error');
      }
    } catch (err) {
      status.className = 'form-status error';
      status.textContent = err.message.includes('Server error')
        ? 'Something went wrong. Please try again shortly.'
        : err.message;
    } finally {
      btn.textContent = orig;
      btn.disabled = false;
    }
  });
})();
