"use client";

import { useEffect, useRef } from "react";

type GridPos = { row: number; col: number };
type ScoreEntry = { name: string; score: number };
type Phase = "start" | "countdown" | "play" | "nameEntry" | "scoreboard";

const COLORS = [0xff595e, 0xffca3a, 0x8ac926, 0x1982c4, 0x6a4c93, 0xff924c, 0xf8fafc];
const ROWS = 10;
const COLS = 10;
const CELL_SIZE = 50;
const BALL_RADIUS = 22;
const GAME_WIDTH = 576;
const GAME_HEIGHT = 1024;
const START_TIME_MS = 90_000;
const LEADERBOARD_KEY = "gumball-blitz-top10";
const CELL_INVALID = -2;
const GLOBE_CENTER_X = GAME_WIDTH / 2;
const GLOBE_CENTER_Y_MOBILE = 350;
const GLOBE_CENTER_Y_DESKTOP = 328;
const GLOBE_INNER_RX = 220;
const GLOBE_INNER_RY = 218;

export default function Match3Game() {
  const mountRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let game: import("phaser").Game | null = null;

    const boot = async () => {
      const Phaser = await import("phaser");

      class Match3Scene extends Phaser.Scene {
        private board: number[][] = [];
        private balls: (Phaser.GameObjects.Image | null)[][] = [];
        private playable: boolean[][] = [];
        private playableCells: GridPos[] = [];
        private rowsByCol: number[][] = [];
        private selected: GridPos | null = null;
        private phase: Phase = "start";
        private locked = true;
        private globeCenterY = GLOBE_CENTER_Y_DESKTOP;
        private lastInteractionMs = 0;
        private hintTween: import("phaser").Tweens.Tween | null = null;
        private hintedCell: GridPos | null = null;

        private boardMask!: import("phaser").Display.Masks.GeometryMask;
        private keyboardHandler?: (event: KeyboardEvent) => void;

        private score = 0;
        private topScores: ScoreEntry[] = [];
        private lastSavedIndex: number | null = null;
        private nameEntry = "";

        private remainingMs = START_TIME_MS;

        private scoreText!: Phaser.GameObjects.Text;
        private timerText!: Phaser.GameObjects.Text;
        private gameOverText!: Phaser.GameObjects.Text;
        private countdownText!: Phaser.GameObjects.Text;
        private selectionRing!: Phaser.GameObjects.Graphics;

        private overlayShade!: Phaser.GameObjects.Rectangle;
        private startPanel!: Phaser.GameObjects.Container;
        private namePanel!: Phaser.GameObjects.Container;
        private scorePanel!: Phaser.GameObjects.Container;

        private initialsText!: Phaser.GameObjects.Text;
        private scoreHeaderText!: Phaser.GameObjects.Text;
        private leaderboardText!: Phaser.GameObjects.Text;

        constructor() {
          super("match3");
        }

        preload() {
          this.load.image("machine-bg-1024", "/images/gumball-machine-1024.webp");
          this.load.image("machine-bg-1536", "/images/gumball-machine-1536.webp");
          this.load.image("machine-bg-2048", "/images/gumball-machine-2048.webp");
          this.load.image("machine-bg-portrait", "/images/gumball-machine-portrait.webp");
        }

        create() {
          this.globeCenterY = window.innerWidth <= 768 ? GLOBE_CENTER_Y_MOBILE : GLOBE_CENTER_Y_DESKTOP;
          this.cameras.main.setBackgroundColor(0x89d8e4);
          this.createBallTextures();
          this.createOverlayTextures();
          this.computeBoardShape();
          this.drawMachineBackdropImage();
          this.createBoardMask();

          this.scoreText = this.add.text(20, 20, "SCORE 00000", {
            color: "#f8fafc",
            fontSize: "30px",
            fontStyle: "bold",
            stroke: "#7f1d1d",
            strokeThickness: 8,
          });

          this.timerText = this.add.text(GAME_WIDTH - 20, 20, "TIME 01:30", {
            color: "#f8fafc",
            fontSize: "30px",
            fontStyle: "bold",
            stroke: "#7f1d1d",
            strokeThickness: 8,
          });
          this.timerText.setOrigin(1, 0);

          this.selectionRing = this.add.graphics().setVisible(false).setDepth(25);

          this.gameOverText = this.add
            .text(GLOBE_CENTER_X, this.globeCenterY + 12, "TIME UP", {
              color: "#ffffff",
              fontSize: "64px",
              fontStyle: "bold",
              stroke: "#7f1d1d",
              strokeThickness: 12,
            })
            .setOrigin(0.5)
            .setDepth(45)
            .setAlpha(0)
            .setScale(0.92);

          this.countdownText = this.add
            .text(GLOBE_CENTER_X, this.globeCenterY + 12, "", {
              color: "#ffffff",
              fontSize: "86px",
              fontStyle: "bold",
              stroke: "#7f1d1d",
              strokeThickness: 14,
            })
            .setOrigin(0.5)
            .setDepth(52)
            .setVisible(false)
            .setAlpha(0);

          this.createOverlays();
          this.topScores = this.loadScores();

          this.keyboardHandler = (event: KeyboardEvent) => this.handleKeyboard(event);
          this.input.keyboard?.on("keydown", this.keyboardHandler);

          this.events.once("shutdown", () => {
            if (this.keyboardHandler) {
              this.input.keyboard?.off("keydown", this.keyboardHandler);
            }
            this.clearIdleHint(false);
          });

          this.initBoardWithPlayableState();
          this.lastInteractionMs = this.time.now;
          this.showStartScreen();
        }

        update() {
          if (this.phase !== "play") {
            this.clearIdleHint(true);
            return;
          }

          this.remainingMs = Math.max(0, this.remainingMs - this.game.loop.delta);
          this.timerText.setText(`TIME ${this.formatTime(this.remainingMs)}`);
          if (this.remainingMs <= 0) {
            this.endGame();
            return;
          }

          if (!this.locked && !this.hintTween && this.time.now - this.lastInteractionMs >= 10_000) {
            this.showIdleHint();
          }
        }

        private computeBoardShape() {
          this.playable = Array.from({ length: ROWS }, () => Array.from({ length: COLS }, () => false));
          this.playableCells = [];
          this.rowsByCol = Array.from({ length: COLS }, () => []);

          for (let row = 0; row < ROWS; row += 1) {
            for (let col = 0; col < COLS; col += 1) {
              const world = this.cellToWorld(row, col);
              const nx = (world.x - GLOBE_CENTER_X) / (GLOBE_INNER_RX - 6);
              const ny = (world.y - this.globeCenterY) / (GLOBE_INNER_RY - 8);
              const inside = nx * nx + ny * ny <= 0.99;
              if (inside) {
                this.playable[row][col] = true;
                this.playableCells.push({ row, col });
                this.rowsByCol[col].push(row);
              }
            }
          }
        }

        private createBoardMask() {
          const maskGraphic = this.add.graphics().setVisible(false);
          maskGraphic.fillStyle(0xffffff, 1);
          maskGraphic.fillEllipse(
            GLOBE_CENTER_X,
            this.globeCenterY,
            (GLOBE_INNER_RX - 2) * 2,
            (GLOBE_INNER_RY - 2) * 2,
          );
          this.boardMask = maskGraphic.createGeometryMask();
        }

        private createOverlayTextures() {
          const glassSize = 640;
          if (!this.textures.exists("glass-caustics")) {
            const tex = this.textures.createCanvas("glass-caustics", glassSize, glassSize);
            if (tex) {
              const ctx = tex.context;
              ctx.clearRect(0, 0, glassSize, glassSize);
              ctx.strokeStyle = "rgba(255,255,255,0.16)";
              ctx.lineWidth = 2.2;
              for (let i = 0; i < 28; i += 1) {
                const y = 70 + i * 18;
                ctx.beginPath();
                ctx.moveTo(80, y);
                ctx.bezierCurveTo(170, y - 22, 260, y + 28, 560, y + 6);
                ctx.stroke();
              }
              const vignette = ctx.createRadialGradient(
                glassSize * 0.5,
                glassSize * 0.5,
                glassSize * 0.12,
                glassSize * 0.5,
                glassSize * 0.5,
                glassSize * 0.5,
              );
              vignette.addColorStop(0, "rgba(255,255,255,0.00)");
              vignette.addColorStop(1, "rgba(255,255,255,0.22)");
              ctx.fillStyle = vignette;
              ctx.fillRect(0, 0, glassSize, glassSize);
              tex.refresh();
            }
          }

          if (!this.textures.exists("glass-sheen")) {
            const tex = this.textures.createCanvas("glass-sheen", glassSize, glassSize);
            if (tex) {
              const ctx = tex.context;
              ctx.clearRect(0, 0, glassSize, glassSize);
              const grad = ctx.createLinearGradient(0, 0, glassSize, glassSize);
              grad.addColorStop(0, "rgba(255,255,255,0.36)");
              grad.addColorStop(0.32, "rgba(255,255,255,0.10)");
              grad.addColorStop(0.65, "rgba(255,255,255,0.03)");
              grad.addColorStop(1, "rgba(255,255,255,0.16)");
              ctx.fillStyle = grad;
              ctx.fillRect(0, 0, glassSize, glassSize);
              tex.refresh();
            }
          }

          if (!this.textures.exists("metal-specular")) {
            const tex = this.textures.createCanvas("metal-specular", 420, 320);
            if (tex) {
              const ctx = tex.context;
              ctx.clearRect(0, 0, 420, 320);
              const grad = ctx.createLinearGradient(0, 0, 420, 0);
              grad.addColorStop(0, "rgba(255,255,255,0.02)");
              grad.addColorStop(0.26, "rgba(255,255,255,0.34)");
              grad.addColorStop(0.5, "rgba(255,255,255,0.09)");
              grad.addColorStop(0.76, "rgba(255,255,255,0.28)");
              grad.addColorStop(1, "rgba(255,255,255,0.03)");
              ctx.fillStyle = grad;
              ctx.fillRect(0, 0, 420, 320);
              ctx.strokeStyle = "rgba(255,255,255,0.07)";
              ctx.lineWidth = 1;
              for (let i = 0; i < 15; i += 1) {
                const x = 20 + i * 26;
                ctx.beginPath();
                ctx.moveTo(x, 24);
                ctx.lineTo(x + 20, 292);
                ctx.stroke();
              }
              tex.refresh();
            }
          }
        }

        private createOverlays() {
          this.overlayShade = this.add
            .rectangle(GAME_WIDTH / 2, GAME_HEIGHT / 2, GAME_WIDTH, GAME_HEIGHT, 0x020617, 0.66)
            .setDepth(60)
            .setVisible(false);

          const startBg = this.add.graphics();
          startBg.fillStyle(0x0f172a, 0.9);
          startBg.fillRoundedRect(-220, -88, 440, 176, 20);
          startBg.lineStyle(4, 0xffffff, 0.2);
          startBg.strokeRoundedRect(-220, -88, 440, 176, 20);

          const startTitle = this.add
            .text(0, -30, "GUMBALL BLITZ", {
              color: "#fef3c7",
              fontSize: "42px",
              fontStyle: "bold",
              stroke: "#7f1d1d",
              strokeThickness: 8,
            })
            .setOrigin(0.5);

          const startHint = this.add
            .text(0, 36, "CLICK TO START", {
              color: "#ffffff",
              fontSize: "30px",
              fontStyle: "bold",
            })
            .setOrigin(0.5);

          this.startPanel = this.add
            .container(GAME_WIDTH / 2, GAME_HEIGHT / 2, [startBg, startTitle, startHint])
            .setDepth(72)
            .setVisible(false);

          const nameBg = this.add.graphics();
          nameBg.fillStyle(0x8b0000, 0.95);
          nameBg.fillRoundedRect(-250, -122, 500, 244, 22);
          nameBg.fillStyle(0x7f1d1d, 1);
          nameBg.fillRoundedRect(-238, -110, 476, 220, 18);
          nameBg.lineStyle(4, 0xf8fafc, 0.28);
          nameBg.strokeRoundedRect(-238, -110, 476, 220, 18);

          const namePromptText = this.add
            .text(0, -58, "ENTER YOUR INITIALS", {
              color: "#fef3c7",
              fontSize: "34px",
              fontStyle: "bold",
              stroke: "#7f1d1d",
              strokeThickness: 7,
              align: "center",
            })
            .setOrigin(0.5);

          this.initialsText = this.add
            .text(0, 10, "_ _ _", {
              color: "#ffffff",
              fontSize: "64px",
              fontStyle: "bold",
              fontFamily: "monospace",
              stroke: "#1f2937",
              strokeThickness: 10,
            })
            .setOrigin(0.5);

          const entryHint = this.add
            .text(0, 76, "A-Z KEYS  |  BACKSPACE  |  ENTER", {
              color: "#fde68a",
              fontSize: "18px",
              fontStyle: "bold",
              align: "center",
            })
            .setOrigin(0.5);

          this.namePanel = this.add
            .container(GAME_WIDTH / 2, GAME_HEIGHT / 2, [nameBg, namePromptText, this.initialsText, entryHint])
            .setDepth(74)
            .setVisible(false);

          const scoreBg = this.add.graphics();
          scoreBg.fillStyle(0x7f1d1d, 0.97);
          scoreBg.fillRoundedRect(-255, -288, 510, 576, 28);
          scoreBg.fillStyle(0xb91c1c, 1);
          scoreBg.fillRoundedRect(-238, -270, 476, 542, 22);
          scoreBg.lineStyle(4, 0xffffff, 0.24);
          scoreBg.strokeRoundedRect(-238, -270, 476, 542, 22);

          this.scoreHeaderText = this.add
            .text(0, -228, "TOP 10", {
              color: "#fef3c7",
              fontSize: "56px",
              fontStyle: "bold",
              stroke: "#7f1d1d",
              strokeThickness: 10,
              align: "center",
            })
            .setOrigin(0.5);

          this.leaderboardText = this.add
            .text(0, -30, "", {
              color: "#ffffff",
              fontSize: "30px",
              fontFamily: "monospace",
              lineSpacing: 8,
              align: "center",
            })
            .setOrigin(0.5, 0.5);

          const replayHint = this.add
            .text(0, 242, "CLICK TO PLAY AGAIN", {
              color: "#fde68a",
              fontSize: "24px",
              fontStyle: "bold",
            })
            .setOrigin(0.5);

          this.scorePanel = this.add
            .container(GAME_WIDTH / 2, GAME_HEIGHT / 2, [scoreBg, this.scoreHeaderText, this.leaderboardText, replayHint])
            .setDepth(76)
            .setVisible(false);
        }

        private showStartScreen() {
          this.phase = "start";
          this.locked = true;
          this.lastSavedIndex = null;
          this.remainingMs = START_TIME_MS;
          this.timerText.setText("TIME 01:30");
          this.scoreText.setText("SCORE 00000");
          this.overlayShade.setVisible(true).setAlpha(0.56);
          this.startPanel.setVisible(true).setAlpha(1).setScale(1);
          this.input.once("pointerdown", () => {
            void this.startCountdown();
          });
        }

        private async startCountdown() {
          if (this.phase !== "start") return;
          this.phase = "countdown";
          await this.tween(this.startPanel, { alpha: 0, scale: 0.95 }, 140, "Quad.easeOut");
          this.startPanel.setVisible(false);
          this.countdownText.setVisible(true);

          const sequence = ["3", "2", "1", "GO!"];
          for (const label of sequence) {
            this.countdownText.setText(label).setAlpha(0).setScale(0.6);
            await this.tween(this.countdownText, { alpha: 1, scale: 1.06 }, 170, "Back.easeOut");
            await this.delay(label === "GO!" ? 180 : 120);
            await this.tween(this.countdownText, { alpha: 0, scale: 1.2 }, 120, "Sine.easeIn");
          }

          this.countdownText.setVisible(false);
          this.overlayShade.setVisible(false);
          this.phase = "play";
          this.locked = false;
        }

        private endGame() {
          this.phase = "nameEntry";
          this.locked = true;
          this.selected = null;
          this.selectionRing.setVisible(false);
          void this.tween(this.gameOverText, { alpha: 1, scale: 1.05 }, 180, "Quad.easeOut");

          this.overlayShade.setVisible(true).setAlpha(0);
          this.namePanel.setVisible(true).setAlpha(0).setScale(0.95);
          this.nameEntry = "";
          this.updateNamePrompt();

          void this.tween(this.overlayShade, { alpha: 0.66 }, 150, "Quad.easeOut");
          void this.tween(this.namePanel, { alpha: 1, scale: 1 }, 190, "Back.easeOut");
        }

        private handleKeyboard(event: KeyboardEvent) {
          if (this.phase === "nameEntry") {
            this.handleNameEntry(event);
          }
        }

        private handleNameEntry(event: KeyboardEvent) {
          const key = event.key.toUpperCase();

          if (key === "BACKSPACE") {
            this.nameEntry = this.nameEntry.slice(0, -1);
            this.updateNamePrompt();
            return;
          }

          if (key === "ENTER") {
            if (this.nameEntry.length === 3) {
              this.saveScore(this.nameEntry, this.score);
              this.showScoreboardScreen();
            }
            return;
          }

          if (/^[A-Z]$/.test(key) && this.nameEntry.length < 3) {
            this.nameEntry += key;
            this.updateNamePrompt();
          }
        }

        private updateNamePrompt() {
          const slots = this.nameEntry.padEnd(3, "_").split("").join(" ");
          this.initialsText.setText(slots);
        }

        private showScoreboardScreen() {
          this.phase = "scoreboard";
          this.namePanel.setVisible(false);
          this.renderLeaderboard();
          this.scoreHeaderText.setText("");
          this.scorePanel.setVisible(true).setAlpha(0).setScale(0.96);
          void this.tween(this.scorePanel, { alpha: 1, scale: 1 }, 200, "Quad.easeOut");
          this.input.once("pointerdown", () => {
            if (this.phase === "scoreboard") {
              this.scene.restart();
            }
          });
        }

        private loadScores(): ScoreEntry[] {
          try {
            const raw = window.localStorage.getItem(LEADERBOARD_KEY);
            if (!raw) return [];
            const parsed = JSON.parse(raw) as ScoreEntry[];
            if (!Array.isArray(parsed)) return [];
            return parsed
              .filter((entry) => typeof entry?.name === "string" && typeof entry?.score === "number")
              .map((entry) => ({ name: entry.name.toUpperCase().slice(0, 3), score: Math.max(0, Math.floor(entry.score)) }))
              .sort((a, b) => b.score - a.score)
              .slice(0, 10);
          } catch {
            return [];
          }
        }

        private saveScore(name: string, score: number) {
          const cleanedName = name.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 3).padEnd(3, "A");
          const newEntry: ScoreEntry = { name: cleanedName, score };
          const sorted = [...this.topScores, newEntry].sort((a, b) => b.score - a.score).slice(0, 10);
          this.topScores = sorted;
          const idx = sorted.indexOf(newEntry);
          this.lastSavedIndex = idx >= 0 ? idx : null;
          window.localStorage.setItem(LEADERBOARD_KEY, JSON.stringify(this.topScores));
        }

        private renderLeaderboard() {
          if (this.topScores.length === 0) {
            this.leaderboardText.setText("NO SCORES YET");
            return;
          }

          const lines = this.topScores.map((entry, i) => {
            const rank = `${i + 1}.`.padStart(2, " ");
            const name = entry.name.padEnd(3, " ");
            const points = entry.score.toString().padStart(5, " ");
            const marker = this.lastSavedIndex === i ? ">>" : "  ";
            return `${marker} ${rank}  ${name}  ${points}`;
          });
          this.leaderboardText.setText(lines.join("\n"));
        }

        private drawMachineBackdropImage() {
          const dpr = window.devicePixelRatio || 1;
          const isPortraitViewport = window.innerHeight >= window.innerWidth;
          const key = isPortraitViewport
            ? "machine-bg-portrait"
            : dpr > 1.6
              ? "machine-bg-2048"
              : dpr > 1.15
                ? "machine-bg-1536"
                : "machine-bg-1024";
          if (this.textures.exists(key)) {
            const tex = this.textures.get(key).getSourceImage() as { width: number; height: number };
            const scale = Math.max(GAME_WIDTH / tex.width, GAME_HEIGHT / tex.height);
            this.add
              .image(GAME_WIDTH / 2, GAME_HEIGHT / 2, key)
              .setScale(scale)
              .setDepth(0);
            return;
          }
          this.drawMachineBackdropFallback();
        }

        private drawMachineBackdropFallback() {
          const g = this.add.graphics();
          const centerX = GLOBE_CENTER_X;
          const globeY = this.globeCenterY;
          const globeR = 284;

          g.fillGradientStyle(0x89ddea, 0x7ed7e5, 0xa5e8f3, 0x93deeb, 1);
          g.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);
          g.fillStyle(0xe5ab47, 1);
          g.fillRect(0, GAME_HEIGHT - 124, GAME_WIDTH, 124);

          g.fillStyle(0x000000, 0.23);
          g.fillEllipse(centerX + 18, GAME_HEIGHT - 82, 404, 58);

          g.fillGradientStyle(0x991014, 0xdb1f27, 0xca1822, 0x6b1012, 1);
          g.fillEllipse(centerX, 93, 322, 96);
          g.fillGradientStyle(0xf06b3b, 0xfc4130, 0xcd1520, 0x8a1114, 1);
          g.fillEllipse(centerX, 89, 290, 64);
          g.lineStyle(4, 0xffffff, 0.34);
          g.strokeEllipse(centerX, 89, 290, 64);

          g.fillStyle(0xe5e7eb, 1);
          g.fillEllipse(centerX, 37, 40, 15);
          g.fillStyle(0x9ca3af, 1);
          g.fillEllipse(centerX, 27, 24, 19);

          g.fillStyle(0xffffff, 0.14);
          g.fillCircle(centerX, globeY, globeR + 10);
          g.fillStyle(0x111827, 0.13);
          g.fillCircle(centerX, globeY + 8, globeR + 4);
          g.fillStyle(0xffffff, 0.16);
          g.fillCircle(centerX, globeY, globeR - 3);

          // No visible grid panel: subtle interior haze only.
          g.fillStyle(0x0a1a2a, 0.16);
          g.fillEllipse(centerX, globeY + 38, GLOBE_INNER_RX * 1.54, GLOBE_INNER_RY * 1.08);

          g.fillStyle(0xffffff, 0.13);
          g.fillEllipse(centerX - globeR * 0.44, globeY - globeR * 0.21, globeR * 0.43, globeR * 1.03);
          g.fillStyle(0xffffff, 0.1);
          g.fillEllipse(centerX + globeR * 0.31, globeY + 12, globeR * 0.18, globeR * 0.68);
          g.fillStyle(0x000000, 0.1);
          g.fillEllipse(centerX, globeY + GLOBE_INNER_RY + 26, GLOBE_INNER_RX * 1.55, 40);

          g.fillGradientStyle(0xe11d20, 0x9e1115, 0xd11720, 0x661113, 1);
          g.fillRoundedRect(centerX - 158, 628, 316, 278, 30);
          g.fillGradientStyle(0x7b0f13, 0x9f1116, 0x7a1013, 0x3f090b, 1);
          g.fillRoundedRect(centerX - 136, 648, 272, 232, 20);

          g.fillStyle(0xeaf2ff, 0.78);
          g.fillRoundedRect(centerX - 92, 694, 184, 44, 14);
          g.fillStyle(0x111827, 1);
          g.fillEllipse(centerX, 716, 100, 34);
          g.fillStyle(0xe2e8f0, 1);
          g.fillEllipse(centerX, 716, 74, 22);

          g.fillStyle(0x64748b, 1);
          g.fillRoundedRect(centerX - 74, 756, 148, 68, 12);
          g.fillStyle(0x1f2937, 1);
          g.fillRoundedRect(centerX - 58, 768, 116, 40, 9);

          g.fillGradientStyle(0xe2e8f0, 0x9ca3af, 0xd1d5db, 0x6b7280, 1);
          g.fillEllipse(centerX + 170, 730, 60, 31);
          g.fillRect(centerX + 170, 724, 50, 12);
          g.fillStyle(0x4b5563, 1);
          g.fillCircle(centerX + 222, 730, 7);

          g.fillGradientStyle(0xb91c1c, 0x7f1d1d, 0xb91c1c, 0x4a0b0c, 1);
          g.fillEllipse(centerX, 914, 394, 50);
          g.fillStyle(0x7f1d1d, 1);
          g.fillEllipse(centerX, 900, 350, 26);

          this.add
            .text(centerX, 124, "GUMBALL BLITZ", {
              color: "#fff1f2",
              fontSize: "50px",
              fontStyle: "bold",
              stroke: "#7f1d1d",
              strokeThickness: 9,
            })
            .setOrigin(0.5, 0.5)
            .setDepth(12);

          // Specular overlay for metallic body.
          this.add
            .image(centerX, 765, "metal-specular")
            .setDepth(19)
            .setAlpha(0.34)
            .setBlendMode(Phaser.BlendModes.SCREEN);

          // Caustic/sheen layers for near-photoreal glass feel.
          this.add
            .image(centerX, globeY + 6, "glass-caustics")
            .setDepth(22)
            .setAlpha(0.2)
            .setBlendMode(Phaser.BlendModes.SCREEN);
          this.add
            .image(centerX, globeY + 8, "glass-sheen")
            .setDepth(23)
            .setAlpha(0.18)
            .setBlendMode(Phaser.BlendModes.SCREEN);

          // Foreground glass reflection over live gameplay balls.
          const frontGlass = this.add.graphics().setDepth(21);
          frontGlass.fillStyle(0xffffff, 0.11);
          frontGlass.fillEllipse(centerX - globeR * 0.42, globeY - globeR * 0.18, globeR * 0.34, globeR * 0.9);
          frontGlass.fillStyle(0xffffff, 0.05);
          frontGlass.fillEllipse(centerX + globeR * 0.28, globeY + 18, globeR * 0.14, globeR * 0.58);
        }

        private createBallTextures() {
          const size = BALL_RADIUS * 2;
          for (let i = 0; i < COLORS.length; i += 1) {
            const key = `ball-${i}`;
            if (this.textures.exists(key)) {
              this.textures.remove(key);
            }
            const texture = this.textures.createCanvas(key, size, size);
            if (!texture) continue;
            const ctx = texture.context;
            const base = this.toRgb(COLORS[i]);
            const cx = BALL_RADIUS;
            const cy = BALL_RADIUS;
            const r = BALL_RADIUS;

            ctx.clearRect(0, 0, size, size);
            const image = ctx.createImageData(size, size);
            const data = image.data;

            const lx = -0.42;
            const ly = -0.54;
            const lz = 0.74;
            const invLen = 1 / Math.hypot(lx, ly, lz);
            const lightX = lx * invLen;
            const lightY = ly * invLen;
            const lightZ = lz * invLen;
            const viewZ = 1;

            for (let y = 0; y < size; y += 1) {
              for (let x = 0; x < size; x += 1) {
                const dx = (x + 0.5 - cx) / r;
                const dy = (y + 0.5 - cy) / r;
                const rr = dx * dx + dy * dy;
                if (rr > 1) continue;

                const dz = Math.sqrt(1 - rr);
                const ndotl = Math.max(0, dx * lightX + dy * lightY + dz * lightZ);
                const ambient = 0.38;
                const diffuse = ndotl * 0.76;

                const hxRaw = lightX;
                const hyRaw = lightY;
                const hzRaw = lightZ + viewZ;
                const hInv = 1 / Math.hypot(hxRaw, hyRaw, hzRaw);
                const hx = hxRaw * hInv;
                const hy = hyRaw * hInv;
                const hz = hzRaw * hInv;

                const spec = Math.pow(Math.max(0, dx * hx + dy * hy + dz * hz), 34) * 0.62;
                const edgeShade = Math.pow(1 - dz, 2.1) * 0.22;
                const lit = Math.min(1.25, ambient + diffuse - edgeShade);

                const idx = (y * size + x) * 4;
                data[idx] = Math.min(255, Math.round(base.r * lit + 255 * spec));
                data[idx + 1] = Math.min(255, Math.round(base.g * lit + 255 * spec));
                data[idx + 2] = Math.min(255, Math.round(base.b * lit + 255 * spec));
                data[idx + 3] = 255;
              }
            }

            ctx.putImageData(image, 0, 0);
            ctx.strokeStyle = "rgba(255,255,255,0.12)";
            ctx.lineWidth = 1.1;
            ctx.beginPath();
            ctx.arc(cx, cy, r - 1.1, 0, Math.PI * 2);
            ctx.stroke();

            texture.refresh();
          }
        }

        private initBoardWithPlayableState() {
          this.clearIdleHint(false);
          let attempts = 0;
          do {
            this.initBoard();
            attempts += 1;
          } while ((!this.hasAvailableMoves() || this.findMatches().length > 0) && attempts < 120);
          this.lastInteractionMs = this.time.now;
        }

        private initBoard() {
          for (const row of this.balls) {
            for (const sprite of row) {
              sprite?.destroy();
            }
          }
          this.board = Array.from({ length: ROWS }, () => Array.from({ length: COLS }, () => CELL_INVALID));
          this.balls = Array.from({ length: ROWS }, () => Array.from({ length: COLS }, () => null));

          for (const { row, col } of this.playableCells) {
            let value = this.randomColor();
            while (this.createsImmediateMatch(row, col, value)) {
              value = this.randomColor();
            }
            this.board[row][col] = value;
            this.balls[row][col] = this.spawnBall(row, col, value);
          }
        }

        private spawnBall(row: number, col: number, colorIndex: number) {
          const { x, y } = this.cellToWorld(row, col);
          const ball = this.add.image(x, y, `ball-${colorIndex}`).setDepth(14).setMask(this.boardMask);
          ball.setInteractive({ useHandCursor: true });
          ball.on("pointerdown", () => {
            void this.handleCellClick({ row, col });
          });
          return ball;
        }

        private async handleCellClick(pos: GridPos) {
          this.onPlayerInteraction();
          if (this.locked || this.phase !== "play" || this.board[pos.row][pos.col] < 0) return;
          if (!this.selected) {
            this.selected = pos;
            this.showSelection(pos);
            return;
          }

          const first = this.selected;
          if (first.row === pos.row && first.col === pos.col) {
            this.selected = null;
            this.selectionRing.setVisible(false);
            return;
          }

          if (!this.isCardinalNeighbor(first, pos)) {
            this.selected = pos;
            this.showSelection(pos);
            return;
          }

          this.locked = true;
          this.selectionRing.setVisible(false);
          this.selected = null;

          await this.swapCells(first, pos);
          const matches = this.findMatches();
          if (matches.length === 0) {
            await this.swapCells(first, pos);
            await this.maybeResetIfNoMoves();
            this.locked = false;
            return;
          }

          await this.resolveCascades(matches);
          await this.maybeResetIfNoMoves();
          this.locked = false;
        }

        private showSelection(pos: GridPos) {
          this.selectionRing.clear();
          this.selectionRing.lineStyle(6, 0xffffff, 0.95);
          const { x, y } = this.cellToWorld(pos.row, pos.col);
          this.selectionRing.strokeCircle(x, y, BALL_RADIUS + 3);
          this.selectionRing.setVisible(true);
        }

        private async resolveCascades(initialMatches: GridPos[]) {
          let matches = initialMatches;
          while (matches.length > 0) {
            const popped = await this.popMatches(matches);
            this.score += popped * 10;
            this.scoreText.setText(`SCORE ${this.score.toString().padStart(5, "0")}`);
            await this.applyGravityAndRefill();
            matches = this.findMatches();
          }
        }

        private async maybeResetIfNoMoves() {
          if (this.phase !== "play") return;
          if (this.hasAvailableMoves()) return;

          this.locked = true;
          this.clearIdleHint(false);
          this.selected = null;
          this.selectionRing.setVisible(false);
          this.countdownText.setText("NO MOVES").setVisible(true).setAlpha(0).setScale(0.8);
          await this.tween(this.countdownText, { alpha: 1, scale: 1 }, 160, "Quad.easeOut");
          await this.delay(220);
          await this.tween(this.countdownText, { alpha: 0 }, 160, "Quad.easeIn");
          this.countdownText.setVisible(false);

          this.initBoardWithPlayableState();
        }

        private async popMatches(matches: GridPos[]) {
          const unique = this.uniqueCells(matches);
          if (this.hintedCell && unique.some((cell) => cell.row === this.hintedCell?.row && cell.col === this.hintedCell?.col)) {
            this.clearIdleHint(false);
          }
          await Promise.all(
            unique.map(async ({ row, col }) => {
              const sprite = this.balls[row][col];
              if (!sprite) return;
              await this.tween(sprite, { scale: 1.28 }, 95, "Sine.easeOut");
              await this.tween(sprite, { scale: 0.03, alpha: 0, angle: sprite.angle + 36 }, 128, "Back.easeIn");
              sprite.destroy();
              this.balls[row][col] = null;
              this.board[row][col] = -1;
            }),
          );
          return unique.length;
        }

        private async applyGravityAndRefill() {
          const moves: Promise<void>[] = [];

          for (let col = 0; col < COLS; col += 1) {
            const rows = this.rowsByCol[col];
            if (rows.length === 0) continue;

            let writeIndex = rows.length - 1;
            for (let readIndex = rows.length - 1; readIndex >= 0; readIndex -= 1) {
              const row = rows[readIndex];
              if (this.board[row][col] >= 0) {
                const writeRow = rows[writeIndex];
                if (row !== writeRow) {
                  const value = this.board[row][col];
                  const sprite = this.balls[row][col];
                  this.board[writeRow][col] = value;
                  this.balls[writeRow][col] = sprite;
                  this.board[row][col] = -1;
                  this.balls[row][col] = null;
                  if (sprite) {
                    moves.push(this.moveBallTo(sprite, writeRow, col, "fall"));
                    this.bindBallPointer(sprite, writeRow, col);
                  }
                }
                writeIndex -= 1;
              }
            }

            for (let i = writeIndex; i >= 0; i -= 1) {
              const row = rows[i];
              const color = this.randomColor();
              this.board[row][col] = color;
              const fromOffset = writeIndex - i + 1;
              const startY = this.cellToWorld(rows[0], col).y - fromOffset * CELL_SIZE;
              const { x } = this.cellToWorld(row, col);
              const sprite = this.add.image(x, startY, `ball-${color}`).setDepth(14).setMask(this.boardMask);
              sprite.setInteractive({ useHandCursor: true });
              sprite.setScale(0.9);
              this.balls[row][col] = sprite;
              this.bindBallPointer(sprite, row, col);
              moves.push(this.moveBallTo(sprite, row, col, "fall"));
            }
          }

          await Promise.all(moves);
        }

        private bindBallPointer(sprite: import("phaser").GameObjects.Image, row: number, col: number) {
          sprite.removeAllListeners("pointerdown");
          sprite.on("pointerdown", () => {
            void this.handleCellClick({ row, col });
          });
        }

        private async swapCells(a: GridPos, b: GridPos) {
          const aVal = this.board[a.row][a.col];
          const bVal = this.board[b.row][b.col];
          const aBall = this.balls[a.row][a.col];
          const bBall = this.balls[b.row][b.col];

          this.board[a.row][a.col] = bVal;
          this.board[b.row][b.col] = aVal;
          this.balls[a.row][a.col] = bBall;
          this.balls[b.row][b.col] = aBall;

          if (aBall && bBall) {
            this.bindBallPointer(aBall, b.row, b.col);
            this.bindBallPointer(bBall, a.row, a.col);
            await Promise.all([
              this.moveBallTo(aBall, b.row, b.col, "swap"),
              this.moveBallTo(bBall, a.row, a.col, "swap"),
            ]);
          }
        }

        private moveBallTo(
          sprite: import("phaser").GameObjects.Image,
          row: number,
          col: number,
          mode: "swap" | "fall",
        ) {
          const { x, y } = this.cellToWorld(row, col);
          const distance = Phaser.Math.Distance.Between(sprite.x, sprite.y, x, y);
          const duration = Phaser.Math.Clamp(130 + distance * 0.55, 150, 340);
          const ease = mode === "fall" ? "Cubic.easeIn" : "Sine.easeInOut";
          return this.tween(sprite, { x, y, scale: 1 }, duration, ease);
        }

        private tween(
          target:
            | import("phaser").GameObjects.Image
            | import("phaser").GameObjects.Text
            | import("phaser").GameObjects.Rectangle
            | import("phaser").GameObjects.Container,
          props: Record<string, number>,
          duration: number,
          ease: string,
        ) {
          return new Promise<void>((resolve) => {
            this.tweens.add({
              targets: target,
              ease,
              duration,
              ...props,
              onComplete: () => resolve(),
            });
          });
        }

        private delay(ms: number) {
          return new Promise<void>((resolve) => {
            this.time.delayedCall(ms, () => resolve());
          });
        }

        private toRgb(color: number) {
          return {
            r: (color >> 16) & 0xff,
            g: (color >> 8) & 0xff,
            b: color & 0xff,
          };
        }

        private formatTime(ms: number) {
          const totalSeconds = Math.ceil(ms / 1000);
          const mins = Math.floor(totalSeconds / 60);
          const secs = totalSeconds % 60;
          return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
        }

        private findMatches() {
          const matches: GridPos[] = [];
          const dirs = [
            [0, 1],
            [1, 0],
            [1, 1],
            [1, -1],
          ];

          for (let row = 0; row < ROWS; row += 1) {
            for (let col = 0; col < COLS; col += 1) {
              const value = this.board[row][col];
              if (value < 0) continue;
              for (const [dr, dc] of dirs) {
                const prevRow = row - dr;
                const prevCol = col - dc;
                if (this.inBounds(prevRow, prevCol) && this.board[prevRow][prevCol] === value) {
                  continue;
                }

                const line: GridPos[] = [];
                let r = row;
                let c = col;
                while (this.inBounds(r, c) && this.board[r][c] === value) {
                  line.push({ row: r, col: c });
                  r += dr;
                  c += dc;
                }

                if (line.length >= 3) {
                  matches.push(...line);
                }
              }
            }
          }

          return this.uniqueCells(matches);
        }

        private hasAvailableMoves() {
          return this.findAvailableMove() !== null;
        }

        private findAvailableMove() {
          const directions = [
            [1, 0],
            [0, 1],
          ];

          for (const a of this.playableCells) {
            for (const [dr, dc] of directions) {
              const b = { row: a.row + dr, col: a.col + dc };
              if (!this.inBounds(b.row, b.col) || !this.playable[b.row][b.col]) continue;
              if (this.swapCreatesMatch(a, b)) {
                return { from: a, to: b };
              }
            }
          }
          return null;
        }

        private onPlayerInteraction() {
          if (this.phase === "play") {
            this.lastInteractionMs = this.time.now;
            this.clearIdleHint(true);
          }
        }

        private showIdleHint() {
          const move = this.findAvailableMove();
          if (!move) return;
          const sprite = this.balls[move.from.row][move.from.col];
          if (!sprite) return;

          this.clearIdleHint(true);
          this.hintedCell = { ...move.from };
          sprite.setScale(1);
          this.hintTween = this.tweens.add({
            targets: sprite,
            scale: 1.16,
            duration: 460,
            ease: "Sine.easeInOut",
            yoyo: true,
            repeat: -1,
            onStop: () => {
              this.hintTween = null;
            },
          });
        }

        private clearIdleHint(resetScale: boolean) {
          if (this.hintTween) {
            this.hintTween.stop();
            this.hintTween = null;
          }
          if (resetScale && this.hintedCell) {
            const sprite = this.balls[this.hintedCell.row][this.hintedCell.col];
            if (sprite) sprite.setScale(1);
          }
          this.hintedCell = null;
        }

        private swapCreatesMatch(a: GridPos, b: GridPos) {
          const aVal = this.board[a.row][a.col];
          const bVal = this.board[b.row][b.col];
          if (aVal < 0 || bVal < 0) return false;

          this.board[a.row][a.col] = bVal;
          this.board[b.row][b.col] = aVal;
          const hasMatch = this.findMatches().length > 0;
          this.board[a.row][a.col] = aVal;
          this.board[b.row][b.col] = bVal;
          return hasMatch;
        }

        private uniqueCells(cells: GridPos[]) {
          const seen = new Set<string>();
          const unique: GridPos[] = [];
          for (const cell of cells) {
            const key = `${cell.row}-${cell.col}`;
            if (!seen.has(key)) {
              seen.add(key);
              unique.push(cell);
            }
          }
          return unique;
        }

        private isCardinalNeighbor(a: GridPos, b: GridPos) {
          const d = Math.abs(a.row - b.row) + Math.abs(a.col - b.col);
          return d === 1;
        }

        private createsImmediateMatch(row: number, col: number, value: number) {
          if (col >= 2 && this.board[row][col - 1] === value && this.board[row][col - 2] === value) return true;
          if (row >= 2 && this.board[row - 1][col] === value && this.board[row - 2][col] === value) return true;
          if (
            row >= 2 &&
            col >= 2 &&
            this.board[row - 1][col - 1] === value &&
            this.board[row - 2][col - 2] === value
          ) {
            return true;
          }
          if (
            row >= 2 &&
            col + 2 < COLS &&
            this.board[row - 1][col + 1] === value &&
            this.board[row - 2][col + 2] === value
          ) {
            return true;
          }
          return false;
        }

        private randomColor() {
          return Phaser.Math.Between(0, COLORS.length - 1);
        }

        private inBounds(row: number, col: number) {
          return row >= 0 && row < ROWS && col >= 0 && col < COLS;
        }

        private cellToWorld(row: number, col: number) {
          const midRow = (ROWS - 1) / 2;
          const midCol = (COLS - 1) / 2;
          const rowOffset = (row - midRow) * 1.5;
          return {
            x: GLOBE_CENTER_X + (col - midCol) * CELL_SIZE + rowOffset,
            y: this.globeCenterY + (row - midRow) * CELL_SIZE,
          };
        }
      }

      game = new Phaser.Game({
        type: Phaser.AUTO,
        width: GAME_WIDTH,
        height: GAME_HEIGHT,
        scale: {
          mode: Phaser.Scale.FIT,
          autoCenter: Phaser.Scale.NO_CENTER,
        },
        parent: mountRef.current ?? undefined,
        transparent: true,
        scene: Match3Scene,
      });
    };

    void boot();

    return () => {
      if (game) {
        game.destroy(true);
      }
    };
  }, []);

  return <div ref={mountRef} className="phaser-root" />;
}
