(() => {
  const rupiah = (n) => `Rp ${Number(n || 0).toLocaleString('id-ID')}`;
  let i18n = {};
  try { i18n = JSON.parse(document.getElementById('i18n')?.textContent || '{}'); } catch { /* keep defaults */ }
  const T = (key, fallback) => i18n[key] || fallback;

  // Mobile sidebar
  const sidebar = document.getElementById('sidebar');
  document.querySelectorAll('[data-toggle-sidebar]').forEach((btn) => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); sidebar?.classList.toggle('open'); });
  });
  document.addEventListener('click', (e) => {
    if (sidebar?.classList.contains('open') && !sidebar.contains(e.target)) sidebar.classList.remove('open');
  });

  // Auto-refresh (queue board) unless the user is interacting with a control
  const auto = document.querySelector('[data-autorefresh]');
  if (auto) {
    const secs = Number(auto.dataset.autorefresh) || 30;
    let last = Date.now();
    ['pointerdown', 'keydown', 'focusin'].forEach((ev) => document.addEventListener(ev, () => { last = Date.now(); }));
    setInterval(() => {
      const busy = document.activeElement && ['SELECT', 'INPUT', 'TEXTAREA'].includes(document.activeElement.tagName);
      if (!busy && Date.now() - last > secs * 1000) location.reload();
    }, 5000);
  }

  // Auto print receipt
  if (document.body.querySelector('[data-autoprint]')) window.addEventListener('load', () => setTimeout(() => window.print(), 300));

  // Confirm dangerous actions
  document.querySelectorAll('form[data-confirm]').forEach((f) => {
    f.addEventListener('submit', (e) => { if (!confirm(f.dataset.confirm)) e.preventDefault(); });
  });

  // ---------- New transaction form ----------
  const form = document.getElementById('tx-form');
  if (!form) return;
  const data = JSON.parse(document.getElementById('price-data').textContent);
  const $ = (id) => document.getElementById(id);
  const selected = (name) => form.querySelector(`input[name="${name}"]:checked`);

  function normalizePlate(v) {
    return v.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/(?<=[A-Z])(?=\d)|(?<=\d)(?=[A-Z])/g, ' ');
  }

  const pkgDefault = $('sum-package').textContent;

  function recalc() {
    const typeId = selected('vehicle_type_id')?.value;
    // Per-package price for the selected vehicle type
    form.querySelectorAll('input[name="package_id"]').forEach((input) => {
      const price = data.prices[`${input.value}:${typeId}`];
      const label = form.querySelector(`[data-price-for="${input.value}"]`);
      if (label) label.textContent = price != null ? rupiah(price) : T('notAvailable', 'Not available');
      input.disabled = price == null;
      if (input.disabled && input.checked) input.checked = false;
    });
    if (!selected('package_id')) {
      const first = form.querySelector('input[name="package_id"]:not(:disabled)');
      if (first) first.checked = true;
    }
    const pkg = selected('package_id');
    const pkgPrice = pkg ? data.prices[`${pkg.value}:${typeId}`] : null;
    const addons = [...form.querySelectorAll('input[name="addon_ids"]:checked')].reduce((s, a) => s + (data.addons[a.value] || 0), 0);
    const subtotal = (pkgPrice || 0) + addons;
    const discount = Math.min(Math.max(Number($('discount').value) || 0, 0), subtotal);

    $('sum-package').textContent = pkg ? pkg.closest('label').querySelector('span').firstChild.textContent.trim() : pkgDefault;
    $('sum-package-price').textContent = pkgPrice != null ? rupiah(pkgPrice) : '—';
    $('sum-addons').textContent = rupiah(addons);
    $('sum-discount').textContent = `− ${rupiah(discount)}`;
    $('sum-total').textContent = pkgPrice != null ? rupiah(subtotal - discount) : '—';
    if ($('mobile-total')) $('mobile-total').textContent = $('sum-total').textContent;
    $('unavailable').hidden = pkgPrice != null;
    $('submit-btn').disabled = pkgPrice == null;
  }

  form.addEventListener('change', recalc);
  $('discount').addEventListener('input', recalc);
  $('pay_now').addEventListener('change', (e) => { $('method-field').hidden = !e.target.checked; });

  // Returning-vehicle lookup by plate
  const plate = $('plate');
  const hint = $('vehicle-hint');
  let timer;
  let lastLookup = '';
  async function lookup() {
    const p = normalizePlate(plate.value);
    if (p.length < 3 || p === lastLookup) return;
    lastLookup = p;
    try {
      const res = await fetch(`/app/api/vehicle?plate=${encodeURIComponent(p)}`, { headers: { Accept: 'application/json' } });
      if (!res.ok) return;
      const { vehicle } = await res.json();
      if (normalizePlate(plate.value) !== p) return;
      if (!vehicle) {
        hint.className = 'vehicle-hint show';
        hint.textContent = T('newVehicle', 'New vehicle');
        return;
      }
      hint.className = 'vehicle-hint show';
      hint.textContent = '';
      const strong = document.createElement('strong');
      strong.textContent = `${T('returning', 'Returning vehicle ✓')} `;
      const typeName = (document.documentElement.lang === 'id' && vehicle.type_name_id) || vehicle.type_name;
      const visits = T('visits', '{n} previous visit(s)').replace('{n}', vehicle.visits);
      hint.append(strong, `${typeName}${vehicle.brand_model ? ` · ${vehicle.brand_model}` : ''}${vehicle.customer_name ? ` · ${vehicle.customer_name}` : ''} · ${visits}`);
      const typeInput = form.querySelector(`input[name="vehicle_type_id"][value="${vehicle.vehicle_type_id}"]`);
      if (typeInput) typeInput.checked = true;
      if (!$('brand_model').value && vehicle.brand_model) $('brand_model').value = vehicle.brand_model;
      if (!$('color').value && vehicle.color) $('color').value = vehicle.color;
      if (!$('customer_name').value && vehicle.customer_name) $('customer_name').value = vehicle.customer_name;
      if (!$('customer_phone').value && vehicle.customer_phone) $('customer_phone').value = vehicle.customer_phone;
      recalc();
    } catch { /* offline or server error: the form still works without the lookup */ }
  }
  plate.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(lookup, 400); });
  plate.addEventListener('blur', () => { plate.value = normalizePlate(plate.value); lookup(); });

  // Hide the sticky total bar once the full summary is on screen
  const bar = document.querySelector('.mobile-total');
  const summary = document.querySelector('.summary');
  if (bar && summary && 'IntersectionObserver' in window) {
    new IntersectionObserver(([e]) => bar.classList.toggle('hide', e.isIntersecting), { threshold: 0.35 }).observe(summary);
  }

  recalc();
  if (plate.value) lookup();
})();
