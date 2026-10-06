// src/lib/loadingBus.js
let inFlight = 0;
const subs = new Set();

function emit() {
  for (const cb of subs) cb(inFlight);
}

export const loadingBus = {
  start() {
    inFlight += 1;
    emit();
  },
  end() {
    inFlight = Math.max(0, inFlight - 1);
    emit();
  },
  subscribe(cb) {
    subs.add(cb);
    cb(inFlight); // push current state immediately
    return () => subs.delete(cb);
  },
  getInFlight() {
    return inFlight;
  },
};
