import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'

const LANES = 4
const laneLabelsP1 = ['A', 'S', 'D', 'F']
const laneLabelsP2 = ['H', 'J', 'K', 'L']

const NOTE_SPEED = 320 // px / second
const SPAWN_INTERVAL = 520 // ms
const HIT_WINDOW = 110 // px (total window size)
const LANE_HEIGHT = 360 // keep in sync with CSS .lane height
const TILE_HEIGHT = 92
const HIT_LINE_Y = LANE_HEIGHT - TILE_HEIGHT - 18

const keyMappings = {
  a: { player: 'p1', lane: 0 },
  s: { player: 'p1', lane: 1 },
  d: { player: 'p1', lane: 2 },
  f: { player: 'p1', lane: 3 },
  h: { player: 'p2', lane: 0 },
  j: { player: 'p2', lane: 1 },
  k: { player: 'p2', lane: 2 },
  l: { player: 'p2', lane: 3 },
}

const laneFreqP1 = [261.63, 293.66, 329.63, 392.0] // C4 D4 E4 G4
const laneFreqP2 = [523.25, 587.33, 659.25, 784.0] // C5 D5 E5 G5

function playTone(audioCtx, freq) {
  const now = audioCtx.currentTime
  const osc = audioCtx.createOscillator()
  const gain = audioCtx.createGain()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(freq, now)
  gain.gain.setValueAtTime(0.0001, now)
  gain.gain.exponentialRampToValueAtTime(0.18, now + 0.01)
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.16)
  osc.connect(gain)
  gain.connect(audioCtx.destination)
  osc.start(now)
  osc.stop(now + 0.18)
}

function App() {
  const [gameState, setGameState] = useState('idle') // idle | countdown | playing | finished
  const [countdown, setCountdown] = useState(3)
  const [timer, setTimer] = useState(60)

  const [notes, setNotes] = useState([]) // { id, lane, y }
  const [cleared, setCleared] = useState({ p1: new Set(), p2: new Set() })
  const [scores, setScores] = useState({ p1: 0, p2: 0 })
  const [failed, setFailed] = useState({ p1: false, p2: false })
  const notesRef = useRef(notes)
  const clearedRef = useRef(cleared)
  const failedRef = useRef(failed)

  useEffect(() => {
    notesRef.current = notes
  }, [notes])
  useEffect(() => {
    clearedRef.current = cleared
  }, [cleared])
  useEffect(() => {
    failedRef.current = failed
  }, [failed])

  const status = useMemo(
    () => ({
      p1: failed.p1 ? 'failed' : gameState === 'playing' ? 'playing' : gameState === 'finished' ? 'finished' : 'ready',
      p2: failed.p2 ? 'failed' : gameState === 'playing' ? 'playing' : gameState === 'finished' ? 'finished' : 'ready',
    }),
    [failed, gameState]
  )

  const [leaderboard, setLeaderboard] = useState(() => {
    const saved = localStorage.getItem('piano-tiles-leaderboard')
    if (!saved) return []
    try {
      return JSON.parse(saved)
    } catch {
      return []
    }
  })
  const [playerName, setPlayerName] = useState('')

  const bestScore = useMemo(
    () => Math.max(scores.p1 ?? 0, scores.p2 ?? 0),
    [scores]
  )

  const startGame = () => {
    setNotes([])
    notesRef.current = []
    setCleared({ p1: new Set(), p2: new Set() })
    clearedRef.current = { p1: new Set(), p2: new Set() }
    setScores({ p1: 0, p2: 0 })
    setFailed({ p1: false, p2: false })
    failedRef.current = { p1: false, p2: false }
    setTimer(60)
    setCountdown(3)
    setGameState('countdown')
  }

  // Countdown before play begins
  useEffect(() => {
    if (gameState !== 'countdown') return
    const id = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(id)
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

  // WebAudio (created lazily on first user input)
  const audioRef = useRef(null)
  const getAudio = () => {
    if (audioRef.current) return audioRef.current
    const AudioContextImpl = window.AudioContext || window.webkitAudioContext
    if (!AudioContextImpl) return null
    audioRef.current = new AudioContextImpl()
    return audioRef.current
  }

  const lastSpawnRef = useRef(null)
  useEffect(() => {
    if (gameState !== 'playing') return
    let rafId
    let lastTs = performance.now()
    lastSpawnRef.current = null

    const tick = (ts) => {
      const dt = ts - lastTs
      lastTs = ts

      let nextNotes = notesRef.current
        .map((n) => ({ ...n, y: n.y + (NOTE_SPEED * dt) / 1000 }))
        .filter((n) => n.y < LANE_HEIGHT + TILE_HEIGHT + 40)

      if (
        lastSpawnRef.current === null ||
        ts - lastSpawnRef.current >= SPAWN_INTERVAL
      ) {
        lastSpawnRef.current = ts
        const lane = Math.floor(Math.random() * LANES)
        const id = crypto.randomUUID ? crypto.randomUUID() : `${ts}-${lane}`
        nextNotes = [...nextNotes, { id, lane, y: -TILE_HEIGHT - 10 }]
      }

      // Commit notes
      notesRef.current = nextNotes
      setNotes(nextNotes)

      // Miss detection: if a note passes the hit line and isn’t cleared, fail that player
      ;(['p1', 'p2']).forEach((player) => {
        if (failedRef.current[player]) return
        const missed = nextNotes.some(
          (n) =>
            n.y > HIT_LINE_Y + HIT_WINDOW / 2 &&
            !clearedRef.current[player].has(n.id)
        )
        if (missed) {
          const nextFailed = { ...failedRef.current, [player]: true }
          failedRef.current = nextFailed
          setFailed(nextFailed)
        }
      })

      if (failedRef.current.p1 && failedRef.current.p2) {
        setGameState('finished')
      }

      rafId = requestAnimationFrame(tick)
    }

    rafId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafId)
  }, [gameState])

  const failPlayer = useCallback((player) => {
    if (failedRef.current[player]) return
    const nextFailed = { ...failedRef.current, [player]: true }
    failedRef.current = nextFailed
    setFailed(nextFailed)
    if (nextFailed.p1 && nextFailed.p2) setGameState('finished')
  }, [])

  const handleKeyDown = useCallback(
    (event) => {
      if (gameState !== 'playing') return

      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key
      const mapping = keyMappings[key]
      if (!mapping) return

      const { player, lane } = mapping
      if (failed[player]) return

      // Find a hittable note in that lane within the hit window (and not yet cleared for this player)
      const hit = notesRef.current.find(
        (n) =>
          n.lane === lane &&
          Math.abs(n.y - HIT_LINE_Y) <= HIT_WINDOW / 2 &&
          !clearedRef.current[player].has(n.id)
      )

      if (!hit) {
        // Tapped white space (or wrong timing) -> fail
        failPlayer(player)
        return
      }

      // Mark cleared for this player + increment score
      const nextCleared = {
        ...clearedRef.current,
        [player]: new Set(clearedRef.current[player]),
      }
      nextCleared[player].add(hit.id)
      clearedRef.current = nextCleared
      setCleared(nextCleared)
      setScores((prev) => ({ ...prev, [player]: prev[player] + 1 }))

      const audio = getAudio()
      if (audio) {
        // resume if suspended (common on first interaction)
        if (audio.state === 'suspended') audio.resume().catch(() => {})
        playTone(audio, player === 'p1' ? laneFreqP1[lane] : laneFreqP2[lane])
      }
    },
    [failed, failPlayer, gameState]
  )

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  const submitScore = () => {
    const trimmed = playerName.trim()
    if (!trimmed) return
    if (bestScore <= 0) return

    const entry = {
      id: crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(),
      name: trimmed.slice(0, 20),
      score: bestScore,
      createdAt: new Date().toISOString(),
    }
    const updated = [...leaderboard, entry]
      .sort((a, b) => b.score - a.score)
      .slice(0, 10)
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
          <p className="eyebrow">Two-player piano tiles</p>
          <h1>Piano Tiles Duel</h1>
          <p className="lede">
            Tiles scroll down. Tap each <strong>black tile exactly once</strong> as it
            reaches the hit line. Tapping empty space or missing a tile ends your run.
          </p>
        </div>
        <div className="header-actions">
          <button className="primary" onClick={startGame}>
            {gameState === 'playing' ? 'Restart' : 'Start'}
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
          <p className="label">Player 1 (ASDF)</p>
          <p className="score">{scores.p1}</p>
          <p className={`pill ${status.p1}`}>{status.p1}</p>
        </div>
        <div className="score-card">
          <p className="label">Player 2 (HJKL)</p>
          <p className="score">{scores.p2}</p>
          <p className={`pill ${status.p2}`}>{status.p2}</p>
        </div>
        <div className="score-card">
          <p className="label">Best</p>
          <p className="score">{bestScore}</p>
          <p className="pill neutral">60s</p>
        </div>
      </section>

      <section className="play-area">
        <PlayerBoard
          title="Player 1 — ASDF"
          status={status.p1}
          score={scores.p1}
          laneLabels={laneLabelsP1}
          notes={notes.filter((n) => !cleared.p1.has(n.id))}
        />
        <PlayerBoard
          title="Player 2 — HJKL"
          status={status.p2}
          score={scores.p2}
          laneLabels={laneLabelsP2}
          notes={notes.filter((n) => !cleared.p2.has(n.id))}
        />
      </section>

      <section className="leaderboard">
        <div className="leaderboard-header">
          <div>
            <p className="label">Leaderboard (Top 10)</p>
            <p className="lede small">Stored locally in this browser.</p>
          </div>
          <button className="ghost" onClick={resetLeaderboard}>
            Clear
          </button>
        </div>
        <div className="leaderboard-table">
          {leaderboard.length === 0 && (
            <p className="muted">No scores yet. Finish a run and submit.</p>
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
            Submit score
          </button>
        </div>
      </section>
    </div>
  )
}

function PlayerBoard({ title, status, score, laneLabels, notes }) {
  return (
    <div className="player-board">
      <div className="player-header">
        <p className="label">{title}</p>
        <p className={`pill ${status}`}>{status}</p>
        <p className="label small">Score: {score}</p>
      </div>
      <div className="lanes">
        {laneLabels.map((label, idx) => {
          const laneNotes = notes?.filter((n) => n.lane === idx) ?? []
          const isHot =
            status === 'playing' &&
            laneNotes.some((n) => Math.abs(n.y - HIT_LINE_Y) <= HIT_WINDOW / 2)
          return (
            <div key={label} className={`lane ${isHot ? 'active' : ''}`}>
              <div className="hit-line" />
              {laneNotes.map((n) => (
                <div
                  key={n.id}
                  className="tile show"
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
