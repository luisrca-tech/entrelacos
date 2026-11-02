interface MotionPreference extends EventTarget {
  readonly matches: boolean;
}

export function mountMotionControls(
  doc: Document,
  preference: MotionPreference,
  onChange?: (paused: boolean) => void,
): () => void {
  const button = doc.querySelector<HTMLButtonElement>("[data-motion-toggle]");
  if (!button) return () => {};
  let paused = preference.matches;
  let chosen = false;
  function render() {
    doc.documentElement.dataset.motion = paused ? "paused" : "active";
    button?.setAttribute("aria-pressed", String(paused));
    if (button)
      button.textContent = paused ? "Ativar animações" : "Pausar animações";
    onChange?.(paused);
  }
  function toggle() {
    chosen = true;
    paused = !paused;
    render();
  }
  function sync() {
    if (!chosen) {
      paused = preference.matches;
      render();
    }
  }
  button.hidden = false;
  render();
  button.addEventListener("click", toggle);
  preference.addEventListener("change", sync);
  return () => {
    button.removeEventListener("click", toggle);
    preference.removeEventListener("change", sync);
  };
}
