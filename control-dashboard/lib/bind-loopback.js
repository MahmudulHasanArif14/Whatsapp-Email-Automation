"use strict";

// Preload (node -r) used when the dashboard starts the OpenWA gateway.
// The gateway calls app.listen(port) which binds every network interface.
// This forces TCP servers in that process onto 127.0.0.1 without editing the
// upstream source, so the gateway is never reachable from the network.

const net = require("node:net");

const original = net.Server.prototype.listen;

net.Server.prototype.listen = function listen(...args) {
  const first = args[0];

  if (typeof first === "number" || (typeof first === "string" && /^\d+$/.test(first))) {
    let rest = args.slice(1);
    if (typeof rest[0] === "string") rest = rest.slice(1); // drop a caller-chosen host
    return original.call(this, Number(first), "127.0.0.1", ...rest);
  }

  if (first && typeof first === "object" && !first.path && !first.fd && !first.handle) {
    args[0] = { ...first, host: "127.0.0.1" };
  }

  return original.apply(this, args);
};
