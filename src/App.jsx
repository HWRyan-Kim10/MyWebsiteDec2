import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  addDoc,
  collection,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
} from 'firebase/firestore'
import { db } from './firebase'
import './App.css'

const LANES = 4
const laneLabelsP1 = ['A', 'S', 'D', 'F']
const laneLabelsP2 = ['H', 'J', 'K', 'L']

const ROUND_SECONDS = 60
const BASE_NOTE_SPEED = 320 // px / second
const MAX_NOTE_SPEED = 1450
const BASE_SPAWN_INTERVAL = 520 // ms
const MIN_SPAWN_INTERVAL = 140
const BASE_HIT_WINDOW = 120 // px (total window size)
const MIN_HIT_WINDOW = 52
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

function playTone(audioCtx, freq, activeOscillatorsRef) {
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
  if (activeOscillatorsRef?.current) {
    activeOscillatorsRef.current.add(osc)
    osc.onended = () => {
      activeOscillatorsRef.current?.delete(osc)
    }
  }
}

function App() {
  const [gameState, setGameState] = useState('idle') // idle | countdown | playing | finished
  const [countdown, setCountdown] = useState(3)
  const [timer, setTimer] = useState(60)

  const [notes, setNotes] = useState([]) // { id, lane, y }
  const [cleared, setCleared] = useState({ p1: new Set(), p2: new Set() })
  const [scores, setScores] = useState({ p1: 0, p2: 0 })
  const [failed, setFailed] = useState({ p1: false, p2: false })
  const [failMeta, setFailMeta] = useState({ p1: null, p2: null })
  const [frozenNotes, setFrozenNotes] = useState({ p1: null, p2: null })
  const [fxPulse, setFxPulse] = useState(null) // { id, kind: 'fail', player: 'p1'|'p2' }
  const notesRef = useRef(notes)
  const clearedRef = useRef(cleared)
  const failedRef = useRef(failed)
  const frozenNotesRef = useRef(frozenNotes)
  const failMetaRef = useRef(failMeta)

  useEffect(() => {
    notesRef.current = notes
  }, [notes])
  useEffect(() => {
    clearedRef.current = cleared
  }, [cleared])
  useEffect(() => {
    failedRef.current = failed
  }, [failed])
  useEffect(() => {
    frozenNotesRef.current = frozenNotes
  }, [frozenNotes])
  useEffect(() => {
    failMetaRef.current = failMeta
  }, [failMeta])

  const status = useMemo(
    () => ({
      p1: failed.p1 ? 'failed' : gameState === 'playing' ? 'playing' : gameState === 'finished' ? 'finished' : 'ready',
      p2: failed.p2 ? 'failed' : gameState === 'playing' ? 'playing' : gameState === 'finished' ? 'finished' : 'ready',
    }),
    [failed, gameState]
  )

  const [leaderboard, setLeaderboard] = useState([])
  const [leaderboardState, setLeaderboardState] = useState({
    loading: true,
    error: null,
  })
  const [playerName, setPlayerName] = useState('')
  const [submitState, setSubmitState] = useState({
    loading: false,
    message: null,
    error: null,
  })

  const bestScore = useMemo(
    () => Math.max(scores.p1 ?? 0, scores.p2 ?? 0),
    [scores]
  )

  const difficulty = useMemo(() => {
    const elapsed = Math.max(0, Math.min(ROUND_SECONDS, ROUND_SECONDS - timer))
    const progress = elapsed / ROUND_SECONDS // 0..1
    // Exponential difficulty: starts ramping early and accelerates hard.
    // speed(t) = BASE * exp(k * progress), capped at MAX
    const speedK = Math.log(MAX_NOTE_SPEED / BASE_NOTE_SPEED)
    const spawnK = Math.log(BASE_SPAWN_INTERVAL / MIN_SPAWN_INTERVAL)
    const windowK = Math.log(BASE_HIT_WINDOW / MIN_HIT_WINDOW)

    const speed = Math.min(
      MAX_NOTE_SPEED,
      BASE_NOTE_SPEED * Math.exp(speedK * progress)
    )
    const spawnInterval = Math.max(
      MIN_SPAWN_INTERVAL,
      BASE_SPAWN_INTERVAL * Math.exp(-spawnK * progress)
    )
    const hitWindow = Math.max(
      MIN_HIT_WINDOW,
      BASE_HIT_WINDOW * Math.exp(-windowK * progress)
    )

    // Use a separate curve for probabilities (convex: increases earlier than power curve did)
    const chanceC = 2.6
    const curve =
      (Math.exp(chanceC * progress) - 1) / (Math.exp(chanceC) - 1) // 0..1
    const lerp = (a, b) => a + (b - a) * curve
    return {
      progress,
      curve,
      speed,
      spawnInterval,
      hitWindow,
      // more stacks/chords near the end
      // these are now used as *targets*; we also enforce chords late-game
      stackChance: lerp(0.05, 0.70),
      chordChance: lerp(0.08, 0.62),
      tripleChance: curve > 0.80 ? (curve - 0.80) / 0.20 * 0.28 : 0,
    }
  }, [timer])

  const speedRef = useRef(BASE_NOTE_SPEED)
  const spawnIntervalRef = useRef(BASE_SPAWN_INTERVAL)
  const hitWindowRef = useRef(BASE_HIT_WINDOW)
  const stackChanceRef = useRef(0)
  const chordChanceRef = useRef(0)
  const tripleChanceRef = useRef(0)
  const progressRef = useRef(0)

  useEffect(() => {
    if (gameState !== 'playing') return
    speedRef.current = difficulty.speed
    spawnIntervalRef.current = difficulty.spawnInterval
    hitWindowRef.current = difficulty.hitWindow
    stackChanceRef.current = difficulty.stackChance
    chordChanceRef.current = difficulty.chordChance
    tripleChanceRef.current = difficulty.tripleChance
    progressRef.current = difficulty.progress
  }, [difficulty, gameState])

  // Global leaderboard (Top 10)
  useEffect(() => {
    const q = query(
      collection(db, 'scores'),
      orderBy('score', 'desc'),
      limit(10)
    )
    const unsubscribe = onSnapshot(
      q,
      (snap) => {
        setLeaderboard(
          snap.docs.map((d) => ({
            id: d.id,
            ...d.data(),
          }))
        )
        setLeaderboardState({ loading: false, error: null })
      },
      (err) => {
        setLeaderboardState({
          loading: false,
          error: err?.message || 'Failed to load leaderboard.',
        })
      }
    )
    return () => unsubscribe()
  }, [])

  const startGame = () => {
    setNotes([])
    notesRef.current = []
    setCleared({ p1: new Set(), p2: new Set() })
    clearedRef.current = { p1: new Set(), p2: new Set() }
    setScores({ p1: 0, p2: 0 })
    setFailed({ p1: false, p2: false })
    failedRef.current = { p1: false, p2: false }
    setFailMeta({ p1: null, p2: null })
    failMetaRef.current = { p1: null, p2: null }
    setFrozenNotes({ p1: null, p2: null })
    frozenNotesRef.current = { p1: null, p2: null }
    setFxPulse(null)
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
  const activeOscillatorsRef = useRef(new Set())
  const getAudio = () => {
    if (audioRef.current) return audioRef.current
    const AudioContextImpl = window.AudioContext || window.webkitAudioContext
    if (!AudioContextImpl) return null
    audioRef.current = new AudioContextImpl()
    return audioRef.current
  }

  const stopAllAudioNow = useCallback(() => {
    const audio = audioRef.current
    if (!audio) return
    activeOscillatorsRef.current.forEach((osc) => {
      try {
        osc.stop()
      } catch {
        // ignore
      }
    })
    activeOscillatorsRef.current.clear()
  }, [])

  const failPlayer = useCallback(
    (player, meta) => {
      if (failedRef.current[player]) return

      // Freeze tiles for this player (visual feedback)
      const snapshot = notesRef.current.map((n) => ({ ...n }))
      const nextFrozen = { ...frozenNotesRef.current, [player]: snapshot }
      frozenNotesRef.current = nextFrozen
      setFrozenNotes(nextFrozen)

      // Record what caused the loss (for highlighting / messaging)
      const nextMeta = {
        ...failMetaRef.current,
        [player]: {
          reason: meta?.reason ?? 'wrong',
          lane: meta?.lane ?? null,
          noteId: meta?.noteId ?? null,
          at: Date.now(),
        },
      }
      failMetaRef.current = nextMeta
      setFailMeta(nextMeta)

      // Mark failed + stop audio immediately (instant interruption)
      const nextFailed = { ...failedRef.current, [player]: true }
      failedRef.current = nextFailed
      setFailed(nextFailed)

      stopAllAudioNow()
      setFxPulse({ id: Date.now(), kind: 'fail', player })

      if (nextFailed.p1 && nextFailed.p2) setGameState('finished')
    },
    [stopAllAudioNow]
  )

  const lastSpawnRef = useRef(null)
  const lastChordAtRef = useRef(0)
  const lastTripleAtRef = useRef(0)
  useEffect(() => {
    if (gameState !== 'playing') return
    let rafId
    let lastTs = performance.now()
    lastSpawnRef.current = null
    lastChordAtRef.current = 0
    lastTripleAtRef.current = 0

    const tick = (ts) => {
      const dt = ts - lastTs
      lastTs = ts

      let nextNotes = notesRef.current
        .map((n) => ({ ...n, y: n.y + (speedRef.current * dt) / 1000 }))
        .filter((n) => n.y < LANE_HEIGHT + TILE_HEIGHT + 40)

      if (
        lastSpawnRef.current === null ||
        ts - lastSpawnRef.current >= spawnIntervalRef.current
      ) {
        lastSpawnRef.current = ts
        const r = Math.random()
        const makeId = (lane, suffix = '') =>
          crypto.randomUUID
            ? crypto.randomUUID()
            : `${ts}-${lane}${suffix ? `-${suffix}` : ''}`

        const progress = progressRef.current
        const late = progress >= 0.55
        const veryLate = progress >= 0.82

        // Force noticeable chords in the second half:
        // If we haven't spawned a chord for ~1.6s late game, force one now.
        const chordDue = late && ts - lastChordAtRef.current > 1600
        // Force a triple chord sometimes near the end so it's obvious.
        const tripleDue = veryLate && ts - lastTripleAtRef.current > 2600

        // Very late game: occasional triple chord
        if (tripleDue || r < tripleChanceRef.current) {
          const lanes = new Set()
          while (lanes.size < 3) lanes.add(Math.floor(Math.random() * LANES))
          const y0 = -TILE_HEIGHT - 10
          nextNotes = [
            ...nextNotes,
            ...Array.from(lanes).map((lane) => ({ id: makeId(lane), lane, y: y0 })),
          ]
          lastTripleAtRef.current = ts
          lastChordAtRef.current = ts
        } else if (r < chordChanceRef.current) {
          // Chord: two lanes at same time (must hit both as they arrive)
          const laneA = Math.floor(Math.random() * LANES)
          let laneB = Math.floor(Math.random() * LANES)
          while (laneB === laneA) laneB = Math.floor(Math.random() * LANES)
          const y0 = -TILE_HEIGHT - 10
          nextNotes = [
            ...nextNotes,
            { id: makeId(laneA, 'a'), lane: laneA, y: y0 },
            { id: makeId(laneB, 'b'), lane: laneB, y: y0 },
          ]
          lastChordAtRef.current = ts
        } else if (r < stackChanceRef.current) {
          // Stack: two (sometimes three) tiles in the same lane (double-tap over time)
          const lane = Math.floor(Math.random() * LANES)
          const y0 = -TILE_HEIGHT - 10
          const y1 = y0 - (TILE_HEIGHT + 14)
          nextNotes = [
            ...nextNotes,
            { id: makeId(lane, '1'), lane, y: y1 },
            { id: makeId(lane, '0'), lane, y: y0 },
          ]
          // Rare third stacked tile near the end
          if (Math.random() < tripleChanceRef.current * 0.6) {
            const y2 = y1 - (TILE_HEIGHT + 14)
            nextNotes = [...nextNotes, { id: makeId(lane, '2'), lane, y: y2 }]
          }
        } else {
          // Single note
          const lane = Math.floor(Math.random() * LANES)
          const id = makeId(lane)
          nextNotes = [...nextNotes, { id, lane, y: -TILE_HEIGHT - 10 }]
        }

        // If a chord is due and we didn't spawn one via chance, override with a chord.
        // (Do this last so it wins over stacks/singles.)
        if (chordDue && ts - lastChordAtRef.current > 0) {
          // already spawned a chord/triple above
        } else if (chordDue) {
          const laneA = Math.floor(Math.random() * LANES)
          let laneB = Math.floor(Math.random() * LANES)
          while (laneB === laneA) laneB = Math.floor(Math.random() * LANES)
          const y0 = -TILE_HEIGHT - 10
          nextNotes = [
            ...nextNotes,
            { id: makeId(laneA, 'fa'), lane: laneA, y: y0 },
            { id: makeId(laneB, 'fb'), lane: laneB, y: y0 },
          ]
          lastChordAtRef.current = ts
        }
      }

      // Commit notes
      notesRef.current = nextNotes
      setNotes(nextNotes)

      // Miss detection: if a note passes the hit line and isn’t cleared, fail that player
      ;(['p1', 'p2']).forEach((player) => {
        if (failedRef.current[player]) return
        const missedNote = nextNotes.find(
          (n) =>
            n.y > HIT_LINE_Y + hitWindowRef.current / 2 &&
            !clearedRef.current[player].has(n.id)
        )
        if (missedNote) {
          failPlayer(player, {
            reason: 'miss',
            lane: missedNote.lane,
            noteId: missedNote.id,
          })
        }
      })

      if (failedRef.current.p1 && failedRef.current.p2) {
      setGameState('finished')
    }

      rafId = requestAnimationFrame(tick)
    }

    rafId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafId)
  }, [gameState, failPlayer])

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
          Math.abs(n.y - HIT_LINE_Y) <= hitWindowRef.current / 2 &&
          !clearedRef.current[player].has(n.id)
      )

      if (!hit) {
        // Tapped white space (or wrong timing) -> fail
        failPlayer(player, { reason: 'wrong', lane, noteId: null })
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
        playTone(
          audio,
          player === 'p1' ? laneFreqP1[lane] : laneFreqP2[lane],
          activeOscillatorsRef
        )
      }
    },
    [failed, failPlayer, gameState]
  )

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  const submitScore = async () => {
    const trimmed = playerName.trim().slice(0, 20)
    if (!trimmed) return
    if (bestScore <= 0) return

    if (submitState.loading) return
    setSubmitState({ loading: true, message: null, error: null })

    try {
      const docRef = await addDoc(collection(db, 'scores'), {
        username: trimmed,
        score: Math.floor(bestScore),
        p1Score: Math.floor(scores.p1 ?? 0),
        p2Score: Math.floor(scores.p2 ?? 0),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        source: 'piano-tiles-duel',
      })

      // Tell the player whether it made Top 10 (otherwise it won't appear).
      const topQ = query(
        collection(db, 'scores'),
        orderBy('score', 'desc'),
        limit(10)
      )
      const topSnap = await getDocs(topQ)
      const madeTop10 = topSnap.docs.some((d) => d.id === docRef.id)

      setSubmitState({
        loading: false,
        message: madeTop10
          ? 'Submitted! You made the Top 10.'
          : 'Submitted! (Not in the Top 10 all-time yet.)',
        error: null,
      })
      setPlayerName('')
    } catch (e) {
      setSubmitState({
        loading: false,
        message: null,
        error:
          e?.message ||
          'Failed to submit score. (Most common: Firestore rules not deployed yet.)',
      })
    }
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
          player="p1"
          title="Player 1 — ASDF"
          status={status.p1}
          score={scores.p1}
          laneLabels={laneLabelsP1}
          failMeta={failMeta.p1}
          fxPulse={fxPulse}
          hitWindow={difficulty.hitWindow}
          notes={
            failed.p1
              ? frozenNotes.p1 ?? []
              : notes.filter((n) => !cleared.p1.has(n.id))
          }
        />
        <PlayerBoard
          player="p2"
          title="Player 2 — HJKL"
          status={status.p2}
          score={scores.p2}
          laneLabels={laneLabelsP2}
          failMeta={failMeta.p2}
          fxPulse={fxPulse}
          hitWindow={difficulty.hitWindow}
          notes={
            failed.p2
              ? frozenNotes.p2 ?? []
              : notes.filter((n) => !cleared.p2.has(n.id))
          }
        />
      </section>

      <section className="leaderboard">
        <div className="leaderboard-header">
      <div>
            <p className="label">Leaderboard (Top 10 — Global)</p>
            <p className="lede small">
              Stored in Firestore (shared across devices). Only Top 10 scores are shown.
            </p>
          </div>
        </div>
        <div className="leaderboard-table">
          {leaderboardState.loading && <p className="muted">Loading…</p>}
          {!leaderboardState.loading && leaderboardState.error && (
            <p className="muted error">{leaderboardState.error}</p>
          )}
          {!leaderboardState.loading &&
            !leaderboardState.error &&
            leaderboard.length === 0 && (
              <p className="muted">No scores yet. Finish a run and submit.</p>
            )}
          {!leaderboardState.loading &&
            !leaderboardState.error &&
            leaderboard.map((entry, idx) => {
              const createdAtDate = entry.createdAt?.toDate
                ? entry.createdAt.toDate()
                : null
              return (
            <div className="row" key={entry.id}>
              <span className="rank">#{idx + 1}</span>
                  <span className="name">{entry.username}</span>
              <span className="score-value">{entry.score} hits</span>
              <span className="date">
                    {createdAtDate ? createdAtDate.toLocaleDateString() : '—'}
              </span>
            </div>
              )
            })}
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
            disabled={gameState !== 'finished' || bestScore <= 0 || submitState.loading}
          >
            {submitState.loading ? 'Submitting…' : 'Submit score'}
          </button>
        </div>
        {(submitState.error || submitState.message) && (
          <p className={`muted ${submitState.error ? 'error' : ''}`}>
            {submitState.error || submitState.message}
          </p>
        )}
      </section>
    </div>
  )
}

function PlayerBoard({ player, title, status, score, laneLabels, notes, failMeta, fxPulse, hitWindow }) {
  const bestKey = player === 'p1' ? 'piano-tiles-best-p1' : 'piano-tiles-best-p2'
  const bestEver = useMemo(() => {
    const raw = localStorage.getItem(bestKey)
    const n = Number(raw)
    return Number.isFinite(n) ? n : 0
  }, [bestKey])

  const isGameOver = status === 'failed' || status === 'finished'
  const isNewRecord = isGameOver && score > bestEver

  useEffect(() => {
    if (!isGameOver) return
    if (score > bestEver) localStorage.setItem(bestKey, String(score))
  }, [bestEver, bestKey, isGameOver, score])

  return (
    <div className={`player-board ${fxPulse?.kind === 'fail' && fxPulse?.player === player ? 'shake' : ''}`}>
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
            laneNotes.some((n) => Math.abs(n.y - HIT_LINE_Y) <= hitWindow / 2)
          const isFailLane = isGameOver && failMeta?.lane === idx
          return (
            <div key={label} className={`lane ${isHot ? 'active' : ''} ${isFailLane ? 'fail' : ''}`}>
              <div className="hit-line" />
              {laneNotes.map((n) => (
                <div
                  key={n.id}
                  className={`tile show ${isGameOver && failMeta?.noteId === n.id ? 'fail' : ''}`}
                  style={{ transform: `translateY(${n.y}px)` }}
                  />
                ))}
              <span className="lane-label">{label}</span>
            </div>
          )
        })}
      </div>

      {status === 'failed' && (
        <div className="gameover-overlay" role="status" aria-live="polite">
          <div className="gameover-card">
            <p className="label">Game Over</p>
            <p className="lede small">
              {failMeta?.reason === 'miss' ? 'Missed a tile.' : 'Tapped empty space.'}
            </p>
            <div className="gameover-stats">
              <div>
                <p className="label small">Score</p>
                <p className="score big">{score}</p>
              </div>
              <div>
                <p className="label small">Best</p>
                <p className="score big">{Math.max(bestEver, score)}</p>
              </div>
            </div>
            {isNewRecord && <p className="new-record">New record!</p>}
          </div>
        </div>
      )}
    </div>
  )
}

export default App
