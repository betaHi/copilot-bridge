#!/usr/bin/env node

import { defineCommand, runMain } from "citty"

import { auth } from "./auth"
import { start } from "./start"

const main = defineCommand({
  meta: {
    name: "copilot-bridge",
    description:
      "Model-layer bridge for routing Codex CLI, Claude Code, and similar clients to GitHub Copilot.",
  },
  subCommands: { auth, start },
})

await runMain(main)
