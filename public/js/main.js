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

// ── Scroll Reveal (with staggered delays) ──────────────────
const staggerGroups = [
  '.features-grid',
  '.problem-effects',
  '.seek-grid',
  '.story-timeline',
];

staggerGroups.forEach(selector => {
  const container = document.querySelector(selector);
  if (!container) return;
  [...container.children].forEach((child, i) => {
    if (child.classList.contains('reveal')) {
      child.style.setProperty('--stagger-delay', `${i * 0.11}s`);
    }
  });
});

document.querySelectorAll('.steps-container .step').forEach((el, i) => {
  el.style.setProperty('--stagger-delay', `${i * 0.15}s`);
});

const revealObserver = new IntersectionObserver((entries) => {
  entries.forEach(({ target, isIntersecting }) => {
    if (!isIntersecting) return;
    target.classList.add('visible');
    revealObserver.unobserve(target);
  });
}, { threshold: 0.08, rootMargin: '0px 0px -40px 0px' });

document.querySelectorAll('.reveal').forEach(el => revealObserver.observe(el));

// ── Counter Animation ──────────────────────────────────────
function animateCounter(el, target, duration, prefix, suffix) {
  const start = performance.now();

  function tick(now) {
    const elapsed = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - elapsed, 3);
    const current = Math.round(target * eased);
    el.textContent = prefix + current + suffix;
    if (elapsed < 1) requestAnimationFrame(tick);
    else el.textContent = prefix + target + suffix;
  }
  requestAnimationFrame(tick);
}

let countersStarted = false;
const statsObserver = new IntersectionObserver(([entry]) => {
  if (!entry.isIntersecting || countersStarted) return;
  countersStarted = true;
  statsObserver.disconnect();

  document.querySelectorAll('[data-counter]').forEach(el => {
    const target  = Number(el.dataset.target);
    const prefix  = el.dataset.prefix  || '';
    const suffix  = el.dataset.suffix  || '';
    const duration = target === 1 ? 900 : (target === 100 ? 1600 : 800);
    animateCounter(el, target, duration, prefix, suffix);
  });
}, { threshold: 0.5 });

const heroStats = document.querySelector('.hero-stats');
if (heroStats) statsObserver.observe(heroStats);

// ── Story Timeline Dot Sequential Animation ────────────────
const storyDots = document.querySelectorAll('.st-dot');

if (storyDots.length) {
  const storyObserver = new IntersectionObserver((entries) => {
    entries.forEach(({ target, isIntersecting }) => {
      if (!isIntersecting) return;
      const idx = [...storyDots].indexOf(target);
      storyDots.forEach((dot, i) => {
        if (i <= idx && !dot.classList.contains('animated')) {
          setTimeout(() => dot.classList.add('animated'), i * 200);
        }
      });
    });
  }, { threshold: 0.5, rootMargin: '0px 0px -60px 0px' });

  storyDots.forEach(dot => storyObserver.observe(dot));
}

// ── Hub Progress Bar Animation ────────────────────────────
const hubSection = document.querySelector('#hub');
const hubBars = document.querySelectorAll('.hm-bar');

if (hubSection && hubBars.length) {
  let hubAnimated = false;
  const hubObserver = new IntersectionObserver(([entry]) => {
    if (!entry.isIntersecting || hubAnimated) return;
    hubAnimated = true;
    hubObserver.disconnect();

    hubBars.forEach((bar, i) => {
      const target = bar.dataset.width || '0%';
      setTimeout(() => {
        bar.style.width = target;
      }, i * 180);
    });
  }, { threshold: 0.3 });

  hubObserver.observe(hubSection);
}

// ── Cycle Timeline Animation ──────────────────────────────
const cycleTimeline = document.querySelector('.cycle-timeline');
const cyclePhases = document.querySelectorAll('.cycle-phase');
const cycleEvents = document.querySelectorAll('.cycle-event');

if (cycleTimeline) {
  let cycleAnimated = false;
  const cycleObserver = new IntersectionObserver(([entry]) => {
    if (!entry.isIntersecting || cycleAnimated) return;
    cycleAnimated = true;
    cycleObserver.disconnect();

    cyclePhases.forEach((phase, i) => {
      const target = phase.dataset.width || phase.style.width || '0%';
      phase.style.width = '0%';
      setTimeout(() => {
        phase.style.width = target;
      }, i * 150);
    });

    cycleEvents.forEach((ev, i) => {
      setTimeout(() => {
        ev.classList.add('animate');
      }, 500 + i * 150);
    });
  }, { threshold: 0.4 });

  cycleObserver.observe(cycleTimeline);
}

// ── Hero Canvas Animation (Enhanced) ───────────────────────
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

  const COUNT = Math.min(80, Math.floor(window.innerWidth / 16));

  const COLORS = [
    [90, 140, 54],
    [143, 203, 68],
    [163, 212, 90],
    [70, 107, 42],
    [107, 76, 42],
  ];

  class Particle {
    constructor(scatter) { this.init(scatter); }
    init(scatter) {
      this.x      = Math.random() * canvas.width;
      this.y      = scatter ? Math.random() * canvas.height : canvas.height + 20;
      this.vy     = -(Math.random() * 0.5 + 0.15);
      this.vx     = (Math.random() - 0.5) * 0.3;
      this.r      = Math.random() * 4 + 1;
      this.phase  = Math.random() * Math.PI * 2;
      this.speed  = Math.random() * 0.015 + 0.010;
      this.alpha  = 0;
      this.wobble = Math.random() * 0.008 + 0.003;
      this.wobblePhase = Math.random() * Math.PI * 2;
      const [r, g, b] = COLORS[Math.floor(Math.random() * COLORS.length)];
      this.color = `${r},${g},${b}`;
      this.isEgg = Math.random() < 0.15;
    }
    update() {
      this.x += this.vx + Math.sin(this.wobblePhase) * this.wobble * 8;
      this.y += this.vy;
      this.phase += this.speed;
      this.wobblePhase += this.wobble;
      this.alpha = Math.sin(this.phase) * 0.22 + 0.12;
      if (this.y < -20) this.init(false);
    }
    draw() {
      ctx.save();
      ctx.globalAlpha = Math.max(0, this.alpha);
      ctx.beginPath();
      if (this.isEgg) {
        ctx.ellipse(this.x, this.y, this.r * 0.65, this.r, 0, 0, Math.PI * 2);
      } else {
        ctx.arc(this.x, this.y, this.r * 0.5, 0, Math.PI * 2);
      }
      ctx.fillStyle = `rgb(${this.color})`;
      ctx.fill();
      ctx.restore();
    }
  }

  function drawConnections(particles) {
    const MAX_DIST = 90;
    for (let i = 0; i < particles.length; i++) {
      for (let j = i + 1; j < particles.length; j++) {
        const dx = particles[i].x - particles[j].x;
        const dy = particles[i].y - particles[j].y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < MAX_DIST) {
          const opacity = (1 - dist / MAX_DIST) * 0.04;
          ctx.beginPath();
          ctx.moveTo(particles[i].x, particles[i].y);
          ctx.lineTo(particles[j].x, particles[j].y);
          ctx.strokeStyle = `rgba(90,140,54,${opacity})`;
          ctx.lineWidth = 0.8;
          ctx.stroke();
        }
      }
    }
  }

  const particles = Array.from({ length: COUNT }, () => new Particle(true));

  let scrollY = 0;
  window.addEventListener('scroll', () => { scrollY = window.scrollY; }, { passive: true });

  function frame() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const grdY = canvas.height * 0.42 - scrollY * 0.05;
    const grd = ctx.createRadialGradient(
      canvas.width * .5, grdY, 0,
      canvas.width * .5, grdY, canvas.width * .65
    );
    grd.addColorStop(0,   'rgba(90,140,54,0.08)');
    grd.addColorStop(0.4, 'rgba(61,107,46,0.04)');
    grd.addColorStop(0.7, 'rgba(107,76,42,0.015)');
    grd.addColorStop(1,   'transparent');
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    drawConnections(particles);
    particles.forEach(p => { p.update(); p.draw(); });
    requestAnimationFrame(frame);
  }
  frame();
})();

// ── Hero Parallax ──────────────────────────────────────────
(function initParallax() {
  const heroContent = document.querySelector('.hero-content');
  const scrollHint  = document.querySelector('.hero-scroll-hint');
  if (!heroContent) return;

  const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (mq.matches) return;

  window.addEventListener('scroll', () => {
    const y = window.scrollY;
    heroContent.style.transform = `translateY(${y * 0.18}px)`;
    if (scrollHint) scrollHint.style.transform =
      `translateX(-50%) translateY(${y * 0.28}px)`;
  }, { passive: true });
})();

// ── Nav Active State Tracking ──────────────────────────────
(function initNavActive() {
  const sections = document.querySelectorAll('section[id]');
  const navLinks = document.querySelectorAll('.nav-links a[href^="#"]');
  if (!sections.length || !navLinks.length) return;

  const sectionObserver = new IntersectionObserver((entries) => {
    entries.forEach(({ target, isIntersecting }) => {
      if (!isIntersecting) return;
      const id = target.getAttribute('id');
      navLinks.forEach(link => {
        const matches = link.getAttribute('href') === `#${id}`;
        link.classList.toggle('nav-active', matches);
      });
    });
  }, { threshold: 0.35, rootMargin: '-80px 0px -60% 0px' });

  sections.forEach(sec => sectionObserver.observe(sec));
})();

// ── Contact Form ───────────────────────────────────────────
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
