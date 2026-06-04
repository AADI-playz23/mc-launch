// ── Plan Definitions (Single Source of Truth) ──
// All plan-related logic across the codebase MUST use this module.

export const PLANS = {
  free: {
    label: 'Free Trial',
    slots: 1,
    ram: '4G',
    cpu: 1,
    sessionHours: 2,
    badge: '#64748b',
  },
  starter: {
    label: 'Starter Orbit',
    slots: 1,
    ram: '4G',
    cpu: 1,
    sessionHours: 6,
    badge: '#06b6d4',
  },
  advanced: {
    label: 'Advanced Core',
    slots: 2,
    ram: '6G',
    cpu: 2,
    sessionHours: 12,
    badge: '#8b5cf6',
  },
  nexus: {
    label: 'Extreme Nexus',
    slots: 3,
    ram: '8G',
    cpu: 2,
    sessionHours: 24,
    badge: '#f59e0b',
  },
  quantum: {
    label: 'Quantum Server',
    slots: 4,
    ram: '16G',
    cpu: 4,
    sessionHours: 24,
    badge: '#10b981',
  },
};

export function getPlan(planName) {
  return PLANS[planName] || PLANS.free;
}

export function getSessionDurationSecs(planName) {
  return getPlan(planName).sessionHours * 3600;
}

export function getRamGb(planName) {
  return parseInt(getPlan(planName).ram.replace('G', ''), 10);
}

export function getCpu(planName) {
  return getPlan(planName).cpu;
}

// Public-safe plan info (no internal fields)
export function getPublicPlans() {
  return Object.entries(PLANS).map(([key, p]) => ({
    id: key,
    label: p.label,
    slots: p.slots,
    ram: p.ram,
    cpu: p.cpu,
    sessionHours: p.sessionHours,
    badge: p.badge,
  }));
}
