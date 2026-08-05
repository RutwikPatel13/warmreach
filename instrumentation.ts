// Next runs register() once when the server process boots. We use it to start
// the scheduled-send sweep loop so a scheduled email fires even if no browser
// tab is ever opened after a (re)start. Node runtime only — the scheduler uses
// fs and googleapis.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startScheduler } = await import("./src/scheduler");
    startScheduler();

    // The job watcher is strictly additive: it starts after the scheduler and
    // inside its own try/catch, so a fault in the newer feature can never stop
    // a scheduled email from going out.
    try {
      const { startJobWatcher } = await import("./src/jobWatch");
      startJobWatcher();
    } catch (err) {
      console.error("job watcher failed to start (scheduled sends unaffected):", err);
    }
  }
}
