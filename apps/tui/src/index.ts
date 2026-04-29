#!/usr/bin/env node
// Embed Agent TUI — Ink-based terminal dashboard

import { render, Box, Text } from "ink";
import React from "react";

function App() {
  return React.createElement(Box, { flexDirection: "column", padding: 1 },
    React.createElement(Text, { bold: true, color: "green" }, "Embed Agent"),
    React.createElement(Box, { marginTop: 1 },
      React.createElement(Text, {}, "Runs: 0 active  |  Targets: 0 idle  |  Cost: $0.00")
    ),
  );
}

render(React.createElement(App));
