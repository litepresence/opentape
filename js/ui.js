// js/ui.js
export function initUI(v) {
  document.documentElement.dataset.theme = v.get().theme;
  document.querySelector('#theme-btn')?.addEventListener('click', () => v.toggleTheme());
  document.querySelectorAll('#rail button').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('#rail button').forEach(x => x.classList.remove('active'));
    b.classList.add('active'); v.set({ tool: b.dataset.tool });
  }));
  setInterval(() => { const el = document.querySelector('#clock'); if (el) el.textContent = new Date().toISOString().slice(11, 19); }, 1000);
}
