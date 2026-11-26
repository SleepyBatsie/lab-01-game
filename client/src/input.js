export function createInput() {
  const keys = new Set();

  window.addEventListener('keydown', (e) => {
    keys.add(e.code);
  });

  window.addEventListener('keyup', (e) => {
    keys.delete(e.code);
  });

  return {
    isDown: (code) => keys.has(code),
    keys
  };
}