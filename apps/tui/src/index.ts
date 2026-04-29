#!/usr/bin/env node
import { render, Box, Text } from "ink";
import React from "react";

function App() {
  return React.createElement(Box, { flexDirection: "column", padding: 1 },
    React.createElement(Text, { bold: true, color: "green" }, "Embed Agent"),
    React.createElement(Box, { marginTop: 1 },
      React.createElement(Text, {}, "Runs: 0  |  Targets: 0  |  Cost: $0.00")
    ),
    React.createElement(Text, { dimColor: true }, "Press q to quit"),
  );
}

render(React.createElement(App));
