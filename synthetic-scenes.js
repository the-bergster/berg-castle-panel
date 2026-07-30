// Synthetic scenes = "scenes" that aren't tied to a specific Pico button.
// Fired as pipelined direct-Lutron #OUTPUT commands.
// Emit the same shape as Pico scenes so the UI treats them uniformly.

const SYNTHETIC_SCENES = [
  {
    id: 'fireplaces-on',
    label: 'Fireplaces On',
    emoji: '🔥',
    home: true, // show on home page
    outputs: [
      { id: 80, level: 100 },  // Office Fireplace
      { id: 151, level: 100 }, // Dining Fireplace
      { id: 152, level: 100 }, // Foyer Fireplace
      { id: 154, level: 100 }, // Master Fireplace
    ],
    fade: 1,
    affected_count: 4,
    area: 'Fireplaces',
    pico_name: 'Berg Castle Panel',
  },
  {
    id: 'fireplaces-off',
    label: 'Fireplaces Off',
    emoji: '🔥',
    home: true,
    outputs: [
      { id: 80, level: 0 },
      { id: 151, level: 0 },
      { id: 152, level: 0 },
      { id: 154, level: 0 },
    ],
    fade: 1,
    affected_count: 4,
    area: 'Fireplaces',
    pico_name: 'Berg Castle Panel',
  },
];

function listSynthetic() { return SYNTHETIC_SCENES; }

function findSynthetic(id) {
  return SYNTHETIC_SCENES.find(s => s.id === id);
}

module.exports = { listSynthetic, findSynthetic };
