import { defineStore } from 'pinia';
import { ref, computed, watch } from 'vue';
import type { Waypoint, NoFlyZone, TerrainPoint, FlightPlan, DroneConfig } from '../types';
import {
  aStarPathfind,
  rrtPathfind,
  smoothPath,
  calculateFlightStats,
  checkTerrainCollision,
  exportKML,
  mockNoFlyZones,
  mockTerrainData,
} from '../utils/pathfinding';

export const useDroneStore = defineStore('drone', () => {
  const waypoints = ref<Waypoint[]>([]);
  const selectedWaypointIds = ref<Set<string>>(new Set());
  const noFlyZones = ref<NoFlyZone[]>([]);
  const terrainData = ref<TerrainPoint[]>([]);
  const currentPlan = ref<FlightPlan | null>(null);
  const selectedAlgorithm = ref<'astar' | 'rrt'>('astar');
  const isSimulating = ref(false);
  const simProgress = ref(0);
  const mapCenter = ref<[number, number]>([39.9, 116.4]);

  const droneConfig = ref<DroneConfig>({
    maxAltitude: 500,
    maxSpeed: 20,
    batteryCapacity: 5000,
    consumptionRate: 100,
    safeDistance: 30,
  });

  // ─── Actions ──────────────────────────────────────────────────────────────
  function addWaypoint(
    lat: number,
    lng: number,
    altitude = 100,
    speed = 10,
    action: Waypoint['action'] = 'none'
  ) {
    const id = `wp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    waypoints.value.push({ id, lat, lng, altitude, speed, action });
  }

  function removeWaypoint(id: string) {
    waypoints.value = waypoints.value.filter((w) => w.id !== id);
  }

  function updateWaypoint(id: string, updates: Partial<Waypoint>) {
    const wp = waypoints.value.find((w) => w.id === id);
    if (wp) Object.assign(wp, updates);
    if (waypoints.value.length >= 2) updatePlan();
  }

  function updateWaypointsBatch(updates: { id: string; changes: Partial<Waypoint> }[]) {
    for (const u of updates) {
      const wp = waypoints.value.find((w) => w.id === u.id);
      if (wp) Object.assign(wp, u.changes);
    }
    if (waypoints.value.length >= 2) updatePlan();
  }

  function isWaypointSelected(id: string): boolean {
    return selectedWaypointIds.value.has(id);
  }

  function toggleWaypointSelection(id: string, additive = false) {
    if (!additive) {
      if (selectedWaypointIds.value.size === 1 && selectedWaypointIds.value.has(id)) {
        selectedWaypointIds.value = new Set();
      } else {
        selectedWaypointIds.value = new Set([id]);
      }
    } else {
      const next = new Set(selectedWaypointIds.value);
      if (next.has(id)) next.delete(id); else next.add(id);
      selectedWaypointIds.value = next;
    }
  }

  function clearWaypointSelection() {
    selectedWaypointIds.value = new Set();
  }

  function selectWaypointsInBox(
    southWest: [number, number],
    northEast: [number, number],
    additive = false
  ) {
    const [minLat, minLng] = southWest;
    const [maxLat, maxLng] = northEast;
    const next = additive ? new Set(selectedWaypointIds.value) : new Set<string>();
    for (const wp of waypoints.value) {
      if (
        wp.lat >= Math.min(minLat, maxLat) &&
        wp.lat <= Math.max(minLat, maxLat) &&
        wp.lng >= Math.min(minLng, maxLng) &&
        wp.lng <= Math.max(minLng, maxLng)
      ) {
        next.add(wp.id);
      }
    }
    selectedWaypointIds.value = next;
  }

  function moveSelectedWaypoints(deltaLat: number, deltaLng: number) {
    if (selectedWaypointIds.value.size === 0) return;
    const updates: { id: string; changes: Partial<Waypoint> }[] = [];
    for (const wp of waypoints.value) {
      if (selectedWaypointIds.value.has(wp.id)) {
        updates.push({ id: wp.id, changes: { lat: wp.lat + deltaLat, lng: wp.lng + deltaLng } });
      }
    }
    updateWaypointsBatch(updates);
  }

  function getSelectedWaypointCount(): number {
    return selectedWaypointIds.value.size;
  }

  function planRoute(start: [number, number], goal: [number, number]) {
    const bounds = { minLat: 39.85, maxLat: 39.95, minLng: 116.35, maxLng: 116.45 };
    let raw: Waypoint[];
    if (selectedAlgorithm.value === 'astar') {
      raw = aStarPathfind(start, goal, 30, noFlyZones.value, bounds);
    } else {
      raw = rrtPathfind(start, goal, noFlyZones.value);
    }
    const smoothed = smoothPath(raw);
    waypoints.value = smoothed;
    updatePlan();
  }

  function clearRoute() {
    waypoints.value = [];
    currentPlan.value = null;
    simProgress.value = 0;
  }

  function updatePlan() {
    const stats = calculateFlightStats(waypoints.value, droneConfig.value);
    currentPlan.value = {
      id: `plan-${Date.now()}`,
      name: 'Flight Plan',
      waypoints: [...waypoints.value],
      totalDistance: stats.totalDistance,
      estimatedTime: stats.estimatedTime,
      batteryUsage: stats.batteryUsage,
    };
  }

  let simInterval: ReturnType<typeof setInterval> | null = null;

  function simulateFlight() {
    if (waypoints.value.length < 2 || isSimulating.value) return;
    isSimulating.value = true;
    simProgress.value = 0;
    simInterval = setInterval(() => {
      simProgress.value += 1;
      if (simProgress.value >= 100) {
        simProgress.value = 100;
        isSimulating.value = false;
        if (simInterval) clearInterval(simInterval);
      }
    }, 50);
  }

  function loadMockData() {
    noFlyZones.value = mockNoFlyZones;
    terrainData.value = mockTerrainData;
  }

  function exportPlan(): string {
    if (!currentPlan.value) return '';
    return exportKML(currentPlan.value);
  }

  watch(
    () => waypoints.value.length,
    () => {
      clearWaypointSelection();
      if (waypoints.value.length >= 2) updatePlan();
    }
  );

  // ─── Computed ─────────────────────────────────────────────────────────────
  const totalDistance = computed(() => {
    if (!currentPlan.value) return 0;
    return currentPlan.value.totalDistance;
  });

  const estimatedTime = computed(() => {
    if (!currentPlan.value) return 0;
    return currentPlan.value.estimatedTime;
  });

  const batteryPercent = computed(() => {
    if (!currentPlan.value) return 0;
    return currentPlan.value.batteryUsage;
  });

  const terrainProfile = computed(() => {
    if (waypoints.value.length < 2) return [];
    return waypoints.value.map((wp) => {
      let nearestElev = 0;
      let minDist = Infinity;
      for (const tp of terrainData.value) {
        const d =
          (tp.lat - wp.lat) ** 2 + (tp.lng - wp.lng) ** 2;
        if (d < minDist) {
          minDist = d;
          nearestElev = tp.elevation;
        }
      }
      return {
        lat: wp.lat,
        lng: wp.lng,
        altitude: wp.altitude,
        terrainElevation: nearestElev,
      };
    });
  });

  return {
    waypoints,
    selectedWaypointIds,
    noFlyZones,
    terrainData,
    currentPlan,
    droneConfig,
    selectedAlgorithm,
    isSimulating,
    simProgress,
    mapCenter,
    totalDistance,
    estimatedTime,
    batteryPercent,
    terrainProfile,
    addWaypoint,
    removeWaypoint,
    updateWaypoint,
    updateWaypointsBatch,
    isWaypointSelected,
    toggleWaypointSelection,
    clearWaypointSelection,
    selectWaypointsInBox,
    moveSelectedWaypoints,
    getSelectedWaypointCount,
    planRoute,
    clearRoute,
    simulateFlight,
    loadMockData,
    exportPlan,
    updatePlan,
  };
});
