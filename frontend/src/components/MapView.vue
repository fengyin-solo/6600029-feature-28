<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch, nextTick } from 'vue';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useDroneStore } from '../store/drone';
import type { Waypoint } from '../types';

const store = useDroneStore();
const mapContainer = ref<HTMLElement>();
let map: L.Map | null = null;
let waypointLayer: L.LayerGroup | null = null;
let routeLayer: L.Polyline | null = null;
let zoneLayer: L.LayerGroup | null = null;
let droneMarker: L.CircleMarker | null = null;
let selectionBoxLayer: L.Rectangle | null = null;

const addMode = ref(false);
const boxSelectMode = ref(false);

const boxStart = ref<L.LatLng | null>(null);
const isBoxDrawing = ref(false);
const shiftPressed = ref(false);

const isDraggingSelection = ref(false);
const dragStartLatLng = ref<L.LatLng | null>(null);
const dragStartWpPositions = ref<Map<string, [number, number]>>(new Map());

const wpMarkerMap = new Map<string, L.CircleMarker>();
const wpIndexMap = new Map<string, number>();

function initMap() {
  if (!mapContainer.value || map) return;
  map = L.map(mapContainer.value).setView(store.mapCenter, 12);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap',
    maxZoom: 18,
  }).addTo(map);

  waypointLayer = L.layerGroup().addTo(map);
  zoneLayer = L.layerGroup().addTo(map);

  map.on('click', (e: L.LeafletMouseEvent) => {
    if (addMode.value) {
      store.addWaypoint(e.latlng.lat, e.latlng.lng);
    } else if (!boxSelectMode.value && !isBoxDrawing.value && !isDraggingSelection.value) {
      store.clearWaypointSelection();
    }
  });

  map.on('mousedown', (e: L.LeafletMouseEvent) => {
    if (!boxSelectMode.value) return;
    if (e.originalEvent.button !== 0) return;
    isBoxDrawing.value = true;
    boxStart.value = e.latlng;
    if (selectionBoxLayer && map) {
      map.removeLayer(selectionBoxLayer);
    }
    selectionBoxLayer = L.rectangle(
      [[e.latlng.lat, e.latlng.lng], [e.latlng.lat, e.latlng.lng]],
      {
        color: '#8b5cf6',
        weight: 1.5,
        dashArray: '4,3',
        fillColor: '#8b5cf6',
        fillOpacity: 0.12,
        interactive: false,
      }
    ).addTo(map);
    L.DomEvent.stopPropagation(e.originalEvent);
  });

  map.on('mousemove', (e: L.LeafletMouseEvent) => {
    if (isBoxDrawing.value && boxStart.value && selectionBoxLayer) {
      selectionBoxLayer.setBounds([
        [boxStart.value.lat, boxStart.value.lng],
        [e.latlng.lat, e.latlng.lng],
      ]);
    }
  });

  map.on('mouseup', (e: L.LeafletMouseEvent) => {
    if (!isBoxDrawing.value || !boxStart.value) return;
    isBoxDrawing.value = false;
    const sw = boxStart.value;
    const ne = e.latlng;
    const moved =
      Math.abs(sw.lat - ne.lat) + Math.abs(sw.lng - ne.lng) > 0.00005;
    if (moved) {
      store.selectWaypointsInBox(
        [Math.min(sw.lat, ne.lat), Math.min(sw.lng, ne.lng)],
        [Math.max(sw.lat, ne.lat), Math.max(sw.lng, ne.lng)],
        shiftPressed.value
      );
    }
    boxStart.value = null;
    if (selectionBoxLayer && map) {
      map.removeLayer(selectionBoxLayer);
      selectionBoxLayer = null;
    }
  });

  const onKeyDown = (ev: KeyboardEvent) => {
    if (ev.key === 'Shift') shiftPressed.value = true;
    if (ev.key === 'Escape') {
      store.clearWaypointSelection();
    }
  };
  const onKeyUp = (ev: KeyboardEvent) => {
    if (ev.key === 'Shift') shiftPressed.value = false;
  };
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  (map as any)._cleanupKeyListeners = () => {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
  };
}

function drawNoFlyZones() {
  if (!zoneLayer) return;
  zoneLayer.clearLayers();
  for (const zone of store.noFlyZones) {
    const color =
      zone.type === 'airport' ? '#ef4444' :
      zone.type === 'military' ? '#f97316' : '#a855f7';
    L.circle([zone.center[0], zone.center[1]], {
      radius: zone.radius,
      color,
      fillColor: color,
      fillOpacity: 0.15,
      weight: 2,
    })
      .bindPopup(`<b>${zone.name}</b><br>Type: ${zone.type}<br>Radius: ${zone.radius}m`)
      .addTo(zoneLayer);
  }
}

function buildIndexMap() {
  wpIndexMap.clear();
  store.waypoints.forEach((wp, i) => wpIndexMap.set(wp.id, i));
}

function drawWaypoints() {
  if (!waypointLayer) return;
  waypointLayer.clearLayers();
  wpMarkerMap.clear();
  buildIndexMap();
  store.waypoints.forEach((wp, idx) => {
    const selected = store.isWaypointSelected(wp.id);
    const marker = L.circleMarker([wp.lat, wp.lng], {
      radius: selected ? 10 : 8,
      color: selected ? '#f59e0b' : '#3b82f6',
      fillColor: selected ? '#fbbf24' : '#60a5fa',
      fillOpacity: 0.95,
      weight: selected ? 3 : 2,
      draggable: true,
    });
    marker.bindTooltip(`WP${idx + 1}${selected ? ' ◆' : ''}`, {
      permanent: true,
      direction: 'top',
      className: 'wp-tooltip' + (selected ? ' wp-tooltip-selected' : ''),
    });
    marker.bindPopup(`
      <div style="min-width:160px">
        <b>Waypoint ${idx + 1}</b><br>
        Altitude: ${wp.altitude}m<br>
        Speed: ${wp.speed} m/s<br>
        Action: ${wp.action}<br>
        <button onclick="this.closest('.leaflet-popup').remove()" style="margin-top:4px;color:#ef4444">Remove</button>
      </div>
    `);

    marker.on('mousedown', (ev: any) => {
      const e: L.LeafletMouseEvent = ev;
      if (boxSelectMode.value) {
        L.DomEvent.stopPropagation(e.originalEvent);
        return;
      }
      L.DomEvent.stopPropagation(e.originalEvent);
      if (!store.isWaypointSelected(wp.id)) {
        store.toggleWaypointSelection(wp.id, shiftPressed.value);
      }
      if (store.isWaypointSelected(wp.id)) {
        isDraggingSelection.value = true;
        dragStartLatLng.value = L.latLng(e.latlng.lat, e.latlng.lng);
        dragStartWpPositions.value = new Map();
        buildIndexMap();
        for (const w of store.waypoints) {
          if (store.isWaypointSelected(w.id)) {
            dragStartWpPositions.value.set(w.id, [w.lat, w.lng]);
          }
        }
      }
    });

    marker.on('click', (ev: any) => {
      L.DomEvent.stopPropagation(ev.originalEvent);
      if (boxSelectMode.value) return;
      if (!isDraggingSelection.value) {
        store.toggleWaypointSelection(wp.id, shiftPressed.value);
      }
    });

    marker.on('drag', (ev: any) => {
      const cur: L.LatLng = ev.target.getLatLng();

      if (!isDraggingSelection.value || !dragStartLatLng.value) {
        const idx = wpIndexMap.get(wp.id);
        if (idx !== undefined) {
          (store.waypoints[idx] as Waypoint).lat = cur.lat;
          (store.waypoints[idx] as Waypoint).lng = cur.lng;
        }
        drawRoute();
        if (store.waypoints.length >= 2) store.updatePlan();
        return;
      }

      const dLat = cur.lat - dragStartLatLng.value.lat;
      const dLng = cur.lng - dragStartLatLng.value.lng;

      for (const [id, [origLat, origLng]] of dragStartWpPositions.value.entries()) {
        const i = wpIndexMap.get(id);
        if (i === undefined) continue;
        if (id === wp.id) {
          (store.waypoints[i] as Waypoint).lat = cur.lat;
          (store.waypoints[i] as Waypoint).lng = cur.lng;
        } else {
          const newLat = origLat + dLat;
          const newLng = origLng + dLng;
          (store.waypoints[i] as Waypoint).lat = newLat;
          (store.waypoints[i] as Waypoint).lng = newLng;
          const otherMarker = wpMarkerMap.get(id);
          if (otherMarker) {
            otherMarker.setLatLng([newLat, newLng]);
            otherMarker.getTooltip()?.setContent(`WP${i + 1} ◆`);
          }
        }
      }
      drawRoute();
      if (store.waypoints.length >= 2) store.updatePlan();
    });

    marker.on('dragend', () => {
      isDraggingSelection.value = false;
      dragStartLatLng.value = null;
      dragStartWpPositions.value = new Map();
    });

    marker.addTo(waypointLayer!);
    wpMarkerMap.set(wp.id, marker);
  });
}

function drawRoute() {
  if (routeLayer && map) {
    map.removeLayer(routeLayer);
    routeLayer = null;
  }
  if (store.waypoints.length < 2 || !map) return;

  const latlngs = store.waypoints.map((w) => [w.lat, w.lng] as [number, number]);

  let hasDanger = false;
  for (const wp of store.waypoints) {
    for (const zone of store.noFlyZones) {
      const d = Math.sqrt(
        (wp.lat - zone.center[0]) ** 2 + (wp.lng - zone.center[1]) ** 2
      ) * 111000;
      if (d < zone.radius * 1.5) hasDanger = true;
    }
  }

  routeLayer = L.polyline(latlngs, {
    color: hasDanger ? '#ef4444' : '#22c55e',
    weight: 3,
    opacity: 0.8,
    dashArray: hasDanger ? '8,4' : undefined,
  }).addTo(map);
}

function drawSimDrone() {
  if (!map || store.waypoints.length < 2) return;
  const progress = store.simProgress / 100;
  const totalWp = store.waypoints.length;
  const segIdx = Math.min(Math.floor(progress * (totalWp - 1)), totalWp - 2);
  const segProgress = (progress * (totalWp - 1)) - segIdx;
  const wp1 = store.waypoints[segIdx];
  const wp2 = store.waypoints[segIdx + 1];
  const lat = wp1.lat + (wp2.lat - wp1.lat) * segProgress;
  const lng = wp1.lng + (wp2.lng - wp1.lng) * segProgress;

  if (droneMarker) {
    droneMarker.setLatLng([lat, lng]);
  } else {
    droneMarker = L.circleMarker([lat, lng], {
      radius: 10,
      color: '#fbbf24',
      fillColor: '#f59e0b',
      fillOpacity: 1,
      weight: 3,
    }).addTo(map);
  }
}

watch(() => store.waypoints.length, () => {
  drawWaypoints();
  drawRoute();
});

watch(() => store.selectedWaypointIds.size, () => {
  drawWaypoints();
});

watch(() => store.noFlyZones.length, drawNoFlyZones);
watch(() => store.simProgress, drawSimDrone);

onMounted(() => {
  nextTick(initMap);
});

onUnmounted(() => {
  if ((map as any)?._cleanupKeyListeners) {
    (map as any)._cleanupKeyListeners();
  }
  if (map) {
    map.remove();
    map = null;
  }
});

function toggleAddMode() {
  addMode.value = !addMode.value;
  if (addMode.value) boxSelectMode.value = false;
}

function toggleBoxSelectMode() {
  boxSelectMode.value = !boxSelectMode.value;
  if (boxSelectMode.value) addMode.value = false;
}

function handlePlanRoute() {
  if (store.waypoints.length < 2) return;
  const first = store.waypoints[0];
  const last = store.waypoints[store.waypoints.length - 1];
  store.planRoute([first.lat, first.lng], [last.lat, last.lng]);
}
</script>

<template>
  <div class="relative w-full h-full">
    <div ref="mapContainer" class="w-full h-full rounded-lg" />
    <div class="absolute top-2 right-2 z-[1000] flex flex-col gap-1">
      <button
        @click="toggleAddMode"
        :class="addMode ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-300'"
        class="px-3 py-1 rounded text-xs font-medium shadow hover:opacity-90 transition"
      >
        {{ addMode ? '✦ 添加模式' : '○ 点击添加' }}
      </button>
      <button
        @click="toggleBoxSelectMode"
        :class="boxSelectMode ? 'bg-purple-600 text-white' : 'bg-gray-800 text-gray-300'"
        class="px-3 py-1 rounded text-xs font-medium shadow hover:opacity-90 transition"
      >
        {{ boxSelectMode ? '▢ 框选中...' : '▢ 框选航点' }}
      </button>
      <button
        @click="store.clearWaypointSelection()"
        :disabled="store.getSelectedWaypointCount() === 0"
        :class="store.getSelectedWaypointCount() === 0 ? 'opacity-40 cursor-not-allowed' : ''"
        class="px-3 py-1 rounded text-xs font-medium bg-gray-800 text-gray-300 shadow hover:opacity-90 transition"
      >
        取消选中 ({{ store.getSelectedWaypointCount() }})
      </button>
      <button
        @click="handlePlanRoute"
        class="px-3 py-1 rounded text-xs font-medium bg-green-700 text-white shadow hover:opacity-90 transition"
      >
        规划航线
      </button>
      <button
        @click="store.clearRoute()"
        class="px-3 py-1 rounded text-xs font-medium bg-red-700 text-white shadow hover:opacity-90 transition"
      >
        清除
      </button>
    </div>
    <div
      v-if="store.getSelectedWaypointCount() > 0 && !boxSelectMode"
      class="absolute bottom-3 left-1/2 -translate-x-1/2 z-[1000] bg-amber-500/90 text-slate-900 px-3 py-1.5 rounded shadow text-xs font-medium"
    >
      🟡 已选中 {{ store.getSelectedWaypointCount() }} 个航点 · 拖动任意一个即可批量移动 · Esc 取消
    </div>
    <div
      v-if="boxSelectMode"
      class="absolute bottom-3 left-1/2 -translate-x-1/2 z-[1000] bg-purple-500/90 text-white px-3 py-1.5 rounded shadow text-xs font-medium"
    >
      ▢ 框选模式：按住左键拖动选框 · Shift+框选加选 · Esc 取消选中
    </div>
  </div>
</template>

<style scoped>
:deep(.wp-tooltip) {
  background: rgba(30, 41, 59, 0.9);
  color: #e2e8f0;
  border: 1px solid #475569;
  font-size: 10px;
  padding: 1px 4px;
  border-radius: 4px;
}
:deep(.wp-tooltip-selected) {
  background: rgba(146, 64, 14, 0.95);
  color: #fef3c7;
  border-color: #f59e0b;
}
</style>
