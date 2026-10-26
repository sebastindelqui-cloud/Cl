// Mapa de Ruta CR: una sola interfaz para dos proveedores.
//
// - Google Maps (mapa y satélite) cuando hay una clave de Google Maps.
// - Sin clave: Leaflet con OpenStreetMap, CARTO (claro y oscuro) o satélite de Esri.
//
// La app solo usa: setStyle, setView, fitBounds, getZoom, addLine, addMarker, destroy.

/** Ícono de parada al estilo de Costa Rica: rótulo azul con el bus en blanco. */
export function stopSvg(size = 26, highlighted = false) {
  const fill = highlighted ? '#0b3d91' : '#1a56c4';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32">`
    + `<rect x="1.5" y="1.5" width="29" height="29" rx="7" fill="${fill}" stroke="#fff" stroke-width="3"/>`
    + '<g fill="#fff"><rect x="9" y="7" width="14" height="15" rx="3"/><rect x="10" y="22" width="3" height="3" rx="1"/><rect x="19" y="22" width="3" height="3" rx="1"/></g>'
    + `<rect x="11" y="9.5" width="10" height="5" rx="1" fill="${fill}"/>`
    + `<circle cx="12" cy="18.5" r="1.4" fill="${fill}"/><circle cx="20" cy="18.5" r="1.4" fill="${fill}"/></svg>`;
}

/** Punto pequeño de parada para cuando el mapa está lejos. */
export function stopDotSvg(color = '#1a56c4') {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 12 12"><circle cx="6" cy="6" r="4.5" fill="${color}" stroke="#fff" stroke-width="2"/></svg>`;
}

/** Pin de origen (A) o destino (B). */
export function pinSvg(label, color) {
  return '<svg xmlns="http://www.w3.org/2000/svg" width="34" height="44" viewBox="0 0 34 44">'
    + `<path d="M17 43c-1-6-15-15-15-26a15 15 0 0 1 30 0c0 11-14 20-15 26z" fill="${color}" stroke="#fff" stroke-width="2.5"/>`
    + `<text x="17" y="22" text-anchor="middle" font-family="system-ui,sans-serif" font-size="15" font-weight="700" fill="#fff">${label}</text></svg>`;
}

/** Punto azul de "estás aquí". */
export function meSvg() {
  return '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28">'
    + '<circle cx="14" cy="14" r="13" fill="#1a73e8" fill-opacity=".18"/><circle cx="14" cy="14" r="7" fill="#1a73e8" stroke="#fff" stroke-width="3"/></svg>';
}

const svgUrl = (svg) => `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;

// ---------- Google Maps ----------

function loadGoogle(key) {
  if (window.google?.maps?.Map) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cb = `__rutaCrMaps${Date.now()}`;
    const timer = setTimeout(() => reject(new Error('Google Maps no respondió.')), 12_000);
    window[cb] = () => { clearTimeout(timer); resolve(); };
    window.gm_authFailure = () => {
      clearTimeout(timer);
      window.dispatchEvent(new CustomEvent('google-maps-auth-failure'));
      reject(new Error('La clave de Google Maps no es válida o no tiene activado "Maps JavaScript API".'));
    };
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&language=es&region=CR&loading=async&callback=${cb}`;
    s.async = true;
    s.onerror = () => { clearTimeout(timer); reject(new Error('No se pudo cargar Google Maps (¿sin internet?).')); };
    document.head.append(s);
  });
}

async function createGoogle(el, { key, center, zoom, onClick, onZoom }) {
  await loadGoogle(key);
  const g = window.google.maps;
  const map = new g.Map(el, {
    center: { lat: center[0], lng: center[1] },
    zoom,
    mapTypeId: 'roadmap',
    disableDefaultUI: true,
    zoomControl: false,
    gestureHandling: 'greedy',
    clickableIcons: false,
    styles: [{ featureType: 'transit.station.bus', stylers: [{ visibility: 'off' }] }],
  });
  map.addListener('click', (e) => onClick?.({ lat: e.latLng.lat(), lng: e.latLng.lng() }));
  map.addListener('zoom_changed', () => onZoom?.(map.getZoom()));
  const toLL = ([lat, lng]) => ({ lat, lng });
  return {
    provider: 'google',
    setStyle(id) { map.setMapTypeId(id === 'google-sat' ? 'hybrid' : 'roadmap'); },
    destroy() { el.innerHTML = ''; },
    setView(ll, z) { map.panTo(toLL(ll)); if (z) map.setZoom(z); },
    fitBounds(points, pad = 48) {
      if (!points.length) return;
      const b = new g.LatLngBounds();
      points.forEach((p) => b.extend(toLL(p)));
      map.fitBounds(b, pad);
      g.event.addListenerOnce(map, 'idle', () => { if (map.getZoom() > 17) map.setZoom(17); });
    },
    getZoom: () => map.getZoom(),
    getCenter() { const c = map.getCenter(); return [c.lat(), c.lng()]; },
    addLine(points, { color, weight = 5, opacity = 1, dashed = false, z = 1 }) {
      const line = new g.Polyline({
        map, path: points.map(toLL), strokeColor: color, strokeWeight: weight, zIndex: z, clickable: false,
        strokeOpacity: dashed ? 0 : opacity,
        icons: dashed ? [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: opacity, strokeColor: color, scale: weight * 0.7 }, offset: '0', repeat: `${weight * 3}px` }] : [],
      });
      return { remove: () => line.setMap(null) };
    },
    addMarker(ll, { svg, size, anchor, z = 10, onClick, title }) {
      const m = new g.Marker({
        map, position: toLL(ll), title, zIndex: z, optimized: true,
        icon: { url: svgUrl(svg), scaledSize: new g.Size(size[0], size[1]), anchor: new g.Point(anchor[0], anchor[1]) },
      });
      if (onClick) m.addListener('click', () => onClick());
      return { remove: () => m.setMap(null), setLatLng: (p) => m.setPosition(toLL(p)) };
    },
  };
}

// ---------- Mapas gratuitos: Leaflet ----------

/** Estilos de mapa que se pueden elegir en la app. */
export const STYLES = [
  { id: 'google-road', name: 'Google Maps', sub: 'Mapa', provider: 'google', type: 'roadmap' },
  { id: 'google-sat', name: 'Google Maps', sub: 'Satélite', provider: 'google', type: 'hybrid' },
  { id: 'osm', name: 'OpenStreetMap', sub: 'Mapa detallado', provider: 'leaflet' },
  { id: 'carto', name: 'Claro', sub: 'Mapa limpio', provider: 'leaflet' },
  { id: 'carto-dark', name: 'Oscuro', sub: 'Para la noche', provider: 'leaflet' },
  { id: 'esri-sat', name: 'Satélite', sub: 'Imágenes Esri', provider: 'leaflet' },
];

function leafletBase(id) {
  const L = window.L;
  const carto = (v) => L.tileLayer(`https://{s}.basemaps.cartocdn.com/rastertiles/${v}/{z}/{x}/{y}{r}.png`, {
    maxZoom: 20, subdomains: 'abcd', attribution: '© OpenStreetMap © CARTO',
  });
  if (id === 'carto') return carto('voyager');
  if (id === 'carto-dark') return L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { maxZoom: 20, subdomains: 'abcd', attribution: '© OpenStreetMap © CARTO' });
  if (id === 'esri-sat') {
    return L.layerGroup([
      L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        maxZoom: 19, attribution: 'Imágenes © Esri, Maxar, Earthstar Geographics',
      }),
      L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19 }),
      L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19 }),
    ]);
  }
  return L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' });
}

function createLeaflet(el, { center, zoom, style = 'osm', onClick, onZoom }) {
  const L = window.L;
  const map = L.map(el, { zoomControl: false, attributionControl: true, preferCanvas: true }).setView(center, zoom);
  let base = null;
  let tileErrors = 0;
  const setBase = (id) => {
    if (base) map.removeLayer(base);
    base = leafletBase(id).addTo(map);
    tileErrors = 0;
    const layers = base.getLayers ? base.getLayers() : [base];
    layers[0].on('tileerror', () => { if (++tileErrors === 4) el.classList.add('no-tiles'); });
    layers[0].on('tileload', () => el.classList.remove('no-tiles'));
  };
  setBase(style);
  map.on('click', (e) => onClick?.({ lat: e.latlng.lat, lng: e.latlng.lng }));
  map.on('zoomend', () => onZoom?.(map.getZoom()));
  return {
    provider: 'leaflet',
    leaflet: map,
    setStyle(id) { setBase(id); },
    destroy() { map.remove(); },
    setView(ll, z) { map.setView(ll, z ?? map.getZoom()); },
    fitBounds(points, pad = 48) {
      if (!points.length) return;
      const p = typeof pad === 'number' ? { top: pad, right: pad, bottom: pad, left: pad } : pad;
      map.fitBounds(points, { paddingTopLeft: [p.left, p.top], paddingBottomRight: [p.right, p.bottom], maxZoom: 17 });
    },
    getZoom: () => map.getZoom(),
    getCenter() { const c = map.getCenter(); return [c.lat, c.lng]; },
    addLine(points, { color, weight = 5, opacity = 1, dashed = false }) {
      const line = L.polyline(points, { color, weight, opacity, dashArray: dashed ? `${weight * 0.5} ${weight * 2}` : null, lineCap: 'round', interactive: false }).addTo(map);
      return { remove: () => line.remove() };
    },
    addMarker(ll, { svg, size, anchor, z = 10, onClick, title }) {
      const m = L.marker(ll, {
        icon: L.divIcon({ className: 'map-svg', html: svg, iconSize: size, iconAnchor: anchor }),
        zIndexOffset: z * 100, title, keyboard: !!onClick, interactive: !!onClick,
      }).addTo(map);
      if (onClick) m.on('click', (e) => { L.DomEvent.stopPropagation(e); onClick(); });
      return { remove: () => m.remove(), setLatLng: (p) => m.setLatLng(p) };
    },
  };
}

/**
 * Crea el mapa con el estilo pedido. Los estilos de Google necesitan clave;
 * si no hay o falla, se usa OpenStreetMap (y se avisa con onFallback).
 */
export async function createMap(el, opts) {
  const style = STYLES.find((s) => s.id === opts.style) || STYLES[2];
  if (style.provider === 'google') {
    if (opts.key) {
      try {
        const m = await createGoogle(el, opts);
        m.setStyle(style.id);
        return m;
      } catch (e) {
        opts.onFallback?.(e.message);
      }
    } else {
      opts.onFallback?.('Para usar Google Maps falta la clave (en Ajustes).');
    }
    el.innerHTML = '';
    return createLeaflet(el, { ...opts, style: 'osm' });
  }
  return createLeaflet(el, { ...opts, style: style.id });
}
