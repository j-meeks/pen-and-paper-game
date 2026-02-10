# 🎮Pen and Paper — The Party Guessing Game

A real-time multiplayer party game where one player asks a question, everyone answers anonymously, and the asker tries to guess who wrote what!

## Quick Start

```bash
node server.js
```

Then open **http://localhost:3000** in your browser. Share the lobby code with friends on the same network.

## How to Play

1. **Create a Lobby** — One person creates a lobby and shares the 5-letter code
2. **Join** — Friends enter the code to join (3-10 players)
3. **Question Phase** (60s) — The current guesser writes a question (e.g. "What's the best pizza topping?")
4. **Answer Phase** (60s) — Everyone else writes their answer anonymously
5. **Reveal Phase** — The guesser reads each answer one by one
6. **Guess Phase** (30s per player) — The guesser matches each answer to a player and locks in
7. **Voting** (20s) — Everyone votes for ⭐ Best Answer and 😂 Funniest Answer
8. **Results** — See who got guessed right, bonus points awarded, scoreboard updates

Each player gets to be the guesser **3 times**. Most points wins!

## Scoring

- **+1 point** for each correct guess (guesser earns these)
- **+1 bonus point** for winning ⭐ Best Answer vote
- **+1 bonus point** for winning 😂 Funniest Answer vote

## Tech Stack

- **Backend**: Node.js with raw WebSocket implementation (zero dependencies!)
- **Frontend**: Single HTML file with vanilla JS
- **No npm install required** — just run `node server.js`

## Project Structure

```
whodat/
├── server.js          # Game server (HTTP + WebSocket)
├── client/
│   └── index.html     # Full game UI
├── package.json
└── README.md
```

## Playing Over the Internet

For now this runs locally. To play with friends on different networks, you can:
- Use a tool like **ngrok** (`ngrok http 3000`) to create a public tunnel
- Deploy to a VPS or cloud provider later

## Future Plans (v2+)

- Drawing canvas for answers
- Custom round counts
- Spectator mode
- Sound effects & music
- Mobile app
