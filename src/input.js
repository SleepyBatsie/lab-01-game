export function createInput() {
  const keys = new Set();

  function onKeyDown(e) {
    keys.add(e.code);
  }

  function onKeyUp(e) {
    keys.delete(e.code);
  }

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);

  return {
    isPressed(code) {
      return keys.has(code);
    },
    destroy() {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    },
  };
}
