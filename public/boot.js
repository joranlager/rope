// Runs before the first paint (a classic script in <head>, so no flash of the wrong splash).
// After the four-tap reload the page shows the short "Reloading" splash instead of the full
// launch splash. The flag is read once and cleared, so an ordinary browser reload, or opening
// the app fresh, shows the launch splash as usual.
try {
  if (sessionStorage.getItem('rope.reload') === '1') {
    document.documentElement.dataset.boot = 'reload';
    sessionStorage.removeItem('rope.reload');
  }
} catch {
  /* storage unavailable: show the launch splash */
}
