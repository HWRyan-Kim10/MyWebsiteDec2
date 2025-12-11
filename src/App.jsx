import { useCallback, useEffect, useMemo, useState } from 'react'
import './App.css'

const laneLabelsP1 = ['A', 'W', 'S', 'D']
const laneLabelsP2 = ['←', '↑', '↓', '→']

const NOTE_SPEED = 220 // px per second
const SPAWN_INTERVAL = 520 // ms between notes
const HIT_LINE_Y = 260 // px from top within lane
const HIT_WINDOW = 90 // px window to count as a hit

const keyMappings = {
  a: { player: 'p1', lane: 0 },
  w: { player: 'p1', lane: 1 },
  s: { player: 'p1', lane: 2 },
  d: { player: 'p1', lane: 3 },
  ArrowLeft: { player: 'p2', lane: 0 },
  ArrowUp: { player: 'p2', lane: 1 },
  ArrowDown: { player: 'p2', lane: 2 },
  ArrowRight: { player: 'p2', lane: 3 },
}

const arrowKeys = new Set(['ArrowLeft', 'ArrowUp', 'ArrowDown', 'ArrowRight'])

function App() {
  const [gameState, setGameState] = useState('idle') // idle | countdown | playing | finished
  const [countdown, setCountdown] = useState(3)
  const [timer, setTimer] = useState(60)
  const [notes, setNotes] = useState([]) // {id, lane, y}
  const [lastSpawn, setLastSpawn] = useState(null)
  const [scores, setScores] = useState({ p1: 0, p2: 0 })
  const [status, setStatus] = useState({ p1: 'ready', p2: 'ready' }) // ready | playing | failed | finished
  const [cleared, setCleared] = useState({ p1: new Set(), p2: new Set() })
  const [leaderboard, setLeaderboard] = useState([])
  const [playerName, setPlayerName] = useState('')
  const [lastWinner, setLastWinner] = useState(null)

  // Load leaderboard from localStorage on first render
  useEffect(() => {
    const saved = localStorage.getItem('piano-tiles-leaderboard')
    if (saved) {
      try {
        setLeaderboard(JSON.parse(saved))
      } catch {
        setLeaderboard([])
      }
    }
  }, [])

  const bestScore = useMemo(
    () => Math.max(scores.p1 ?? 0, scores.p2 ?? 0),
    [scores]
  )

  const activeNotes = useMemo(
    () => ({
      p1: notes.filter((n) => !cleared.p1.has(n.id)),
      p2: notes.filter((n) => !cleared.p2.has(n.id)),
    }),
    [notes, cleared]
  )

  const startGame = () => {
    setNotes([])
    setLastSpawn(null)
    setScores({ p1: 0, p2: 0 })
    setStatus({ p1: 'ready', p2: 'ready' })
    setCleared({ p1: new Set(), p2: new Set() })
    setLastWinner(null)
    setTimer(60)
    setCountdown(3)
    setGameState('countdown')
  }

  // Countdown before play begins
  useEffect(() => {
    if (gameState !== 'countdown') return
    setCountdown(3)
    const id = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(id)
          setStatus({ p1: 'playing', p2: 'playing' })
          setGameState('playing')
          return 0
        }
        return prev - 1
      })
    }, 1000)
    return () => clearInterval(id)
  }, [gameState])

  // Main 60s timer
  useEffect(() => {
    if (gameState !== 'playing') return
    const id = setInterval(() => {
      setTimer((prev) => {
        if (prev <= 1) {
          clearInterval(id)
          setGameState('finished')
          return 0
        }
        return prev - 1
      })
    }, 1000)
    return () => clearInterval(id)
  }, [gameState])

  // Spawn and animate falling notes
  useEffect(() => {
    if (gameState !== 'playing') return
    let rafId
    let lastTs = performance.now()
    const tick = (ts) => {
      const dt = ts - lastTs
      lastTs = ts

      setNotes((prev) =>
        prev
          .map((n) => ({ ...n, y: n.y + (NOTE_SPEED * dt) / 1000 }))
          .filter((n) => n.y < HIT_LINE_Y + HIT_WINDOW * 2) // keep until safely past
      )

      setLastSpawn((prev) => {
        if (prev === null || ts - prev >= SPAWN_INTERVAL) {
          const lane = Math.floor(Math.random() * 4)
          const id = crypto.randomUUID ? crypto.randomUUID() : `${ts}-${lane}`
          setNotes((prevNotes) => [...prevNotes, { id, lane, y: -140 }])
          return ts
        }
        return prev
      })

      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafId)
  }, [gameState])

  // End early if both players fail
  useEffect(() => {
    if (gameState !== 'playing') return
    if (status.p1 === 'failed' && status.p2 === 'failed') {
      setGameState('finished')
    }
  }, [gameState, status])

  // Decide winner when finished
  useEffect(() => {
    if (gameState !== 'finished') return
    if (scores.p1 === scores.p2) {
      setLastWinner('draw')
    } else {
      setLastWinner(scores.p1 > scores.p2 ? 'p1' : 'p2')
    }
    setStatus((prev) => ({
      p1: prev.p1 === 'failed' ? 'failed' : 'finished',
      p2: prev.p2 === 'failed' ? 'failed' : 'finished',
    }))
  }, [gameState, scores])

  const handleKeyDown = useCallback(
    (event) => {
      if (gameState !== 'playing') return
      const key =
        event.key.length === 1 ? event.key.toLowerCase() : event.key
      if (arrowKeys.has(event.key)) {
        event.preventDefault() // prevent page scroll when using arrow keys
      }
      const mapping = keyMappings[key]
      if (!mapping) return
      if (status[mapping.player] === 'failed') return
      setNotes((prev) => {
        const idx = prev.findIndex(
          (n) =>
            n.lane === mapping.lane &&
            Math.abs(n.y - HIT_LINE_Y) <= HIT_WINDOW / 2 &&
            !cleared[mapping.player].has(n.id)
        )
        if (idx === -1) {
          setStatus((s) => ({ ...s, [mapping.player]: 'failed' }))
          return prev
        }
        const note = prev[idx]
        setCleared((c) => {
          const next = {
            ...c,
            [mapping.player]: new Set(c[mapping.player]),
          }
          next[mapping.player].add(note.id)
          return next
        })
        setScores((prevScore) => ({
          ...prevScore,
          [mapping.player]: prevScore[mapping.player] + 1,
        }))
        return prev
      })
    },
    [cleared, gameState, status]
  )

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  // Miss detection: if a note passes the hit window and isn’t cleared, fail that player
  useEffect(() => {
    if (gameState !== 'playing') return
    const checkMiss = (player) =>
      notes.some(
        (n) => n.y > HIT_LINE_Y + HIT_WINDOW && !cleared[player].has(n.id)
      )
    setStatus((prev) => {
      const next = { ...prev }
      if (prev.p1 !== 'failed' && checkMiss('p1')) next.p1 = 'failed'
      if (prev.p2 !== 'failed' && checkMiss('p2')) next.p2 = 'failed'
      if (next.p1 !== prev.p1 || next.p2 !== prev.p2) {
        if (next.p1 === 'failed' && next.p2 === 'failed') setGameState('finished')
        return next
      }
      return prev
    })
  }, [gameState, notes, cleared])

  const submitScore = () => {
    const trimmed = playerName.trim()
    if (!trimmed) return
    const entry = {
      id: crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(),
      name: trimmed,
      score: bestScore,
      createdAt: new Date().toISOString(),
    }
    const updated = [...leaderboard, entry]
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
    setLeaderboard(updated)
    localStorage.setItem('piano-tiles-leaderboard', JSON.stringify(updated))
    setPlayerName('')
  }

  const resetLeaderboard = () => {
    setLeaderboard([])
    localStorage.removeItem('piano-tiles-leaderboard')
  }

  return (
    <div className="app-shell">
      <header className="page-header">
        <div>
          <p className="eyebrow">Same-keyboard duel</p>
          <h1>Competitive Piano Tiles</h1>
          <p className="lede">
            Player 1 uses <strong>WASD only</strong> on the left board. Player 2 uses
            <strong> Arrow keys only</strong> on the right board. The tile only moves
            when the correct key is hit; a wrong key ends that player&apos;s run.
            Rack up hits within 60 seconds.
          </p>
        </div>
        <div className="header-actions">
          <button className="primary" onClick={startGame}>
            {gameState === 'playing' ? 'Restart' : 'Start Round'}
          </button>
          <div className="timers">
            {gameState === 'countdown' ? (
              <span className="countdown">Starts in {countdown}</span>
            ) : (
              <span className="timer">Time left: {timer}s</span>
            )}
            <span className="state-pill">{gameState}</span>
          </div>
        </div>
      </header>

      <section className="status-row">
        <div className="score-card">
          <p className="label">Player 1 (WASD)</p>
          <p className="score">{scores.p1}</p>
          <p className={`pill ${status.p1}`}>{status.p1}</p>
        </div>
        <div className="score-card">
          <p className="label">Player 2 (Arrows)</p>
          <p className="score">{scores.p2}</p>
          <p className={`pill ${status.p2}`}>{status.p2}</p>
        </div>
        <div className="score-card">
          <p className="label">Winner</p>
          <p className="score">
            {lastWinner === 'draw'
              ? 'Draw'
              : lastWinner === 'p1'
                ? 'P1'
                : lastWinner === 'p2'
                  ? 'P2'
                  : '—'}
          </p>
          <p className="pill neutral">best: {bestScore}</p>
        </div>
      </section>

      <section className="play-area">
        <PlayerBoard
          title="Player 1 — WASD"
          status={status.p1}
          score={scores.p1}
          laneLabels={laneLabelsP1}
          notes={activeNotes.p1}
        />
        <PlayerBoard
          title="Player 2 — Arrow Keys"
          status={status.p2}
          score={scores.p2}
          flip
          laneLabels={laneLabelsP2}
          notes={activeNotes.p2}
        />
      </section>

      <section className="leaderboard">
        <div className="leaderboard-header">
      <div>
            <p className="label">Leaderboard (Top 5)</p>
            <p className="lede small">
              Stored locally. Add a backend later for global scores.
            </p>
          </div>
          <button className="ghost" onClick={resetLeaderboard}>
            Clear
          </button>
        </div>
        <div className="leaderboard-table">
          {leaderboard.length === 0 && (
            <p className="muted">No scores yet. Finish a round and submit.</p>
          )}
          {leaderboard.map((entry, idx) => (
            <div className="row" key={entry.id}>
              <span className="rank">#{idx + 1}</span>
              <span className="name">{entry.name}</span>
              <span className="score-value">{entry.score} hits</span>
              <span className="date">
                {new Date(entry.createdAt).toLocaleDateString()}
              </span>
            </div>
          ))}
        </div>
        <div className="submit-row">
          <input
            type="text"
            placeholder="Name / initials"
            value={playerName}
            onChange={(e) => setPlayerName(e.target.value)}
          />
          <button
            className="primary"
            onClick={submitScore}
            disabled={gameState !== 'finished' || bestScore <= 0}
          >
            Submit best score
          </button>
        </div>
      </section>

      <section className="rules">
        <h2>How it works</h2>
        <ul>
          <li>Both players see the same tile order for fairness.</li>
          <li>Hit the highlighted lane key. One mistake ends that player&apos;s run.</li>
          <li>Round lasts 60 seconds or until both fail.</li>
          <li>Most correct hits wins. Submit the best score to the leaderboard.</li>
          <li>Use the restart button to instantly replay.</li>
        </ul>
      </section>
    </div>
  )
}

function PlayerBoard({
  title,
  status,
  score,
  laneLabels,
  notes,
  flip = false,
}) {
  return (
    <div className={`player-board ${flip ? 'flip' : ''}`}>
      <div className="player-header">
        <p className="label">{title}</p>
        <p className={`pill ${status}`}>{status}</p>
        <p className="label small">Score: {score}</p>
      </div>
      <div className="lanes">
        {(flip ? [...laneLabels].reverse() : laneLabels).map((label, idx) => {
          const laneIndex = flip ? laneLabels.length - 1 - idx : idx
          const laneNotes = notes?.filter((n) => n.lane === laneIndex) ?? []
          return (
            <div
              key={label}
              className={`lane ${status === 'failed' ? 'disabled' : ''}`}
            >
              <div className="hit-line" />
              {laneNotes.map((n) => (
                <div
                  key={n.id}
                  className="note"
                  style={{ transform: `translateY(${n.y}px)` }}
                />
              ))}
              <span className="lane-label">{label}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default App
