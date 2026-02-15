import { describe, expect, it, vi } from "vitest";
import { isCodeExplorationCommand } from "./pi-tools.js";

describe("isCodeExplorationCommand", () => {
  describe("should BLOCK grep/rg/ack/ag (always)", () => {
    const blocked = [
      "grep -n loadFromSerializableState store/gameStore.ts",
      "grep -rn TODO src/",
      'grep -A 30 "loadFromSerializableState:" store/gameStore.ts',
      "rg loadFromSerializableState",
      "rg --type ts TODO",
      "ack TODO src/",
      "ag pattern src/",
    ];
    for (const cmd of blocked) {
      it(`blocks: ${cmd}`, () => {
        expect(isCodeExplorationCommand(cmd)).toBe(true);
      });
    }
  });

  describe("should BLOCK with cd prefix", () => {
    const blocked = [
      "cd monopoly && grep -n loadFromSerializableState store/gameStore.ts",
      "cd monopoly && grep -A 30 loadFromSerializableState store/gameStore.ts | head -5",
      "cd src; grep -rn TODO .",
      "cd /home/user/project && rg pattern",
    ];
    for (const cmd of blocked) {
      it(`blocks: ${cmd}`, () => {
        expect(isCodeExplorationCommand(cmd)).toBe(true);
      });
    }
  });

  describe("should BLOCK cat/head/tail/find/sed/awk/wc on code files", () => {
    const blocked = [
      "cat src/index.ts",
      "head -20 store/gameStore.ts",
      "tail -50 lib/utils.js",
      "find . -name '*.ts' -type f",
      "find src -name '*.py'",
      "sed -n '10,20p' main.go",
      "awk '/function/' app.tsx",
      "wc -l src/index.rs",
    ];
    for (const cmd of blocked) {
      it(`blocks: ${cmd}`, () => {
        expect(isCodeExplorationCommand(cmd)).toBe(true);
      });
    }
  });

  describe("should NOT block legitimate commands", () => {
    const allowed = [
      // gh CLI piped to head/grep
      "gh pr view 18 --repo imzodev/monopoly --json title,body | head -100",
      "gh pr list | grep open",
      // build/test/lint commands
      "npm test",
      "bun test",
      "pnpm build",
      "npx vitest run",
      "cargo build",
      "make all",
      // git commands
      "git log --oneline -10",
      "git diff HEAD~1",
      "git status",
      // docker/system commands
      "docker ps | head -5",
      "docker logs container_id | tail -20",
      "ps aux | grep node",
      // curl/wget
      "curl -s https://api.example.com | head -10",
      // cat/head on non-code files
      "cat README.md",
      "head -20 package.json",
      "tail -50 output.log",
      "cat /etc/hosts",
      // ls/pwd/echo
      "ls -la src/",
      "pwd",
      "echo hello",
      // npm/yarn/pnpm
      "npm install",
      "yarn add react",
      // empty/whitespace
      "",
      "   ",
    ];
    for (const cmd of allowed) {
      it(`allows: ${JSON.stringify(cmd)}`, () => {
        expect(isCodeExplorationCommand(cmd)).toBe(false);
      });
    }
  });

  describe("should NOT block find/cat/head without code extensions", () => {
    const allowed = [
      "find . -name '*.log'",
      "find /tmp -type d",
      "cat config.yaml",
      "head -5 Makefile",
      "tail output.txt",
      "wc -l data.csv",
    ];
    for (const cmd of allowed) {
      it(`allows: ${cmd}`, () => {
        expect(isCodeExplorationCommand(cmd)).toBe(false);
      });
    }
  });
});
