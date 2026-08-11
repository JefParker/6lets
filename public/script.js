// Safe storage wrapper to prevent Safari Private Mode from crashing
const safeStorage = {
    getItem(key) {
        try {
            return window.localStorage.getItem(key);
        } catch (e) {
            console.warn('localStorage is not available:', e);
            return null;
        }
    },
    setItem(key, value) {
        try {
            window.localStorage.setItem(key, value);
        } catch (e) {
            console.warn('localStorage is not available:', e);
        }
    },
    removeItem(key) {
        try {
            window.localStorage.removeItem(key);
        } catch (e) {
            console.warn('localStorage is not available:', e);
        }
    },
    clear() {
        try {
            window.localStorage.clear();
        } catch (e) {
            console.warn('localStorage is not available:', e);
        }
    }
};

if (!safeStorage.getItem('6lets_wiped_v1')) {
    safeStorage.clear();
    safeStorage.setItem('6lets_wiped_v1', 'true');
}

const WORD_LENGTH = 6;
const MAX_GUESSES = 10;
const RECENT_GAMES_LIMIT = 10;
// Ceiling on the offline result queue so a persistent server-side rejection
// can't grow it without bound.
const MAX_PENDING_SYNC = 50;
let guesses = [];
let currentGuess = '';
let gameId = '';
let targetWord = 'SODIUM'; // Fallback offline word
// False while `targetWord` is still the fallback, i.e. we don't actually know
// today's answer yet.
let targetWordResolved = false;
let gameState = 'playing'; // playing, won, lost
let startTime = null;
let elapsedTimeMs = 0;
// True while a submitted guess is mid flip-reveal; input is locked out.
let isRevealing = false;

// Theme initialization
const savedTheme = safeStorage.getItem('6lets_theme') || 'original';
document.documentElement.setAttribute('data-theme', savedTheme);

// Puzzle identity. Mirrors lib/puzzle.js on the server — keep the two in sync.
const PUZZLE_EPOCH_NUMBER = 3298;
const PUZZLE_EPOCH_UTC = Date.UTC(2026, 6, 8); // July 8, 2026
const GAME_ID_PATTERN = /^\d{4}-\d{2}-\d{2}-(AM|PM)$/;

// Determine Game ID and Date (LA Time)
//
// NOTE: `hour12: false` is deliberately NOT used. It selects hour cycle h24 in
// several engines, which formats midnight as "24" rather than "00" — that reads
// as >= 12 and served the PM word during the first hour of the AM puzzle.
// `hourCycle: 'h23'` is unambiguous.
function getGameId() {
    // Current time in Los Angeles
    const options = { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' };
    const formatter = new Intl.DateTimeFormat('en-US', options);
    const parts = formatter.formatToParts(new Date());

    let year, month, day, hour;
    for (const part of parts) {
        if (part.type === 'year') year = part.value;
        if (part.type === 'month') month = part.value;
        if (part.type === 'day') day = part.value;
        if (part.type === 'hour') hour = parseInt(part.value, 10);
    }

    // Belt and braces in case an engine still hands back h24.
    if (hour === 24) hour = 0;

    const ampm = hour < 12 ? 'AM' : 'PM';
    return `${year}-${month}-${day}-${ampm}`;
}

function getUserUUID() {
    const existing = safeStorage.getItem('6lets_uuid');
    if (existing) return existing;

    // Prefer crypto.randomUUID (secure contexts); fall back to a manual v4
    // generator so first-run still works if it's unavailable.
    const uuid = (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
        ? crypto.randomUUID()
        : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
            const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });

    safeStorage.setItem('6lets_uuid', uuid);
    return uuid;
}

// Stats
let completedGames = parseInt(safeStorage.getItem('6lets_completed')) || 0;
let unfinishedGames = parseInt(safeStorage.getItem('6lets_unfinished')) || 0;
let totalGuessesFinished = parseInt(safeStorage.getItem('6lets_totalGuesses')) || 0;
let guessDistribution = JSON.parse(safeStorage.getItem('6lets_distribution')) || [0,0,0,0,0,0,0,0,0,0];

let rawGames = JSON.parse(safeStorage.getItem('6lets_recentGames')) || [];
let recentGames = [];
let seenPuzzles = new Set();
let needsResave = false;

rawGames.forEach(game => {
    const puzzleMatch = game.match(/(#\d+)/);
    if (puzzleMatch) {
        if (!seenPuzzles.has(puzzleMatch[1])) {
            seenPuzzles.add(puzzleMatch[1]);
            recentGames.push(game);
        } else {
            // It's a duplicate. Adjust stats downwards.
            needsResave = true;
            const guessMatch = game.match(/- (\d+) guesses/);
            if (guessMatch) {
                const g = parseInt(guessMatch[1]);
                completedGames = Math.max(0, completedGames - 1);
                totalGuessesFinished = Math.max(0, totalGuessesFinished - g);
                if (g > 0 && g <= 10) {
                    guessDistribution[g - 1] = Math.max(0, guessDistribution[g - 1] - 1);
                }
            } else if (game.includes('- X guesses')) {
                unfinishedGames = Math.max(0, unfinishedGames - 1);
            }
        }
    } else {
        recentGames.push(game);
    }
});

if (needsResave) {
    safeStorage.setItem('6lets_completed', completedGames);
    safeStorage.setItem('6lets_unfinished', unfinishedGames);
    safeStorage.setItem('6lets_totalGuesses', totalGuessesFinished);
    safeStorage.setItem('6lets_distribution', JSON.stringify(guessDistribution));
    safeStorage.setItem('6lets_recentGames', JSON.stringify(recentGames));
}

let initialStreak = parseInt(safeStorage.getItem('6lets_streak')) || 0;
if (initialStreak > completedGames) {
    safeStorage.setItem('6lets_streak', completedGames);
}

// Initialize board
function renderBoard() {
    const board = document.getElementById('board');
    board.innerHTML = '';
    
    guesses.forEach((guess) => {
        const row = document.createElement('div');
        row.className = 'row';
        const evaluation = evaluateGuess(guess, targetWord);
        for (let j = 0; j < WORD_LENGTH; j++) {
            const tile = document.createElement('div');
            tile.className = 'tile';
            tile.textContent = guess[j];
            tile.dataset.state = evaluation[j];
            row.appendChild(tile);
        }
        board.appendChild(row);
    });

    if (gameState === 'playing' && guesses.length < MAX_GUESSES) {
        const row = document.createElement('div');
        row.className = 'row';
        if (guesses.length > 0) row.classList.add('slide-in');
        row.id = 'active-row';
        for (let j = 0; j < WORD_LENGTH; j++) {
            const tile = document.createElement('div');
            tile.className = 'tile';
            tile.dataset.state = 'tbd';
            tile.textContent = currentGuess[j] || '';
            row.appendChild(tile);
        }
        board.appendChild(row);
    }
    
    updateKeyboardColors();
    
    let displayNum = gameState === 'playing' ? guesses.length + 1 : guesses.length;
    displayNum = Math.min(displayNum, MAX_GUESSES);
    document.getElementById('guess-counter').textContent = `${displayNum}/${MAX_GUESSES}`;
}

// Initialize Keyboard
function initKeyboard() {
    const keyboard = document.getElementById('keyboard');
    keyboard.innerHTML = '';
    const keys = [
        ['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P'],
        ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L'],
        ['Backspace', 'Z', 'X', 'C', 'V', 'B', 'N', 'M', 'Enter']
    ];

    keys.forEach(rowKeys => {
        const row = document.createElement('div');
        row.className = 'keyboard-row';
        rowKeys.forEach(key => {
            const button = document.createElement('button');
            button.className = 'key';
            button.dataset.key = key;
            if (key === 'Enter') {
                button.textContent = 'ENT';
                button.classList.add('large');
            } else if (key === 'Backspace') {
                button.textContent = 'DEL';
                button.classList.add('large');
            } else {
                button.textContent = key;
            }
            
            button.addEventListener('click', () => handleKeyPress(key));
            row.appendChild(button);
        });
        keyboard.appendChild(row);
    });
}

// Update the grid based on current state
function updateActiveRow() {
    const activeRow = document.getElementById('active-row');
    if (!activeRow) return;
    
    for (let j = 0; j < WORD_LENGTH; j++) {
        const tile = activeRow.children[j];
        tile.textContent = currentGuess[j] || '';
        
        if (currentGuess[j] && tile.dataset.state === 'tbd' && !tile.classList.contains('pop')) {
            tile.classList.add('pop');
            setTimeout(() => tile.classList.remove('pop'), 100);
        }
    }
}

// Update keyboard colors based on evaluations
function updateKeyboardColors() {
    const keyButtons = document.querySelectorAll('.key');
    const letterStates = {};
    
    guesses.forEach(guess => {
        const evaluation = evaluateGuess(guess, targetWord);
        for (let i = 0; i < WORD_LENGTH; i++) {
            const char = guess[i];
            const state = evaluation[i];
            
            if (state === 'correct') {
                letterStates[char] = 'correct';
            } else if (state === 'present' && letterStates[char] !== 'correct') {
                letterStates[char] = 'present';
            } else if (state === 'absent' && !letterStates[char]) {
                letterStates[char] = 'absent';
            }
        }
    });
    
    keyButtons.forEach(btn => {
        const key = btn.dataset.key;
        if (letterStates[key]) {
            btn.dataset.state = letterStates[key];
        }
    });
}

function evaluateGuess(guess, target) {
    const evaluation = Array(WORD_LENGTH).fill('absent');
    const targetChars = target.split('');
    const guessChars = guess.split('');

    // First pass: correct
    for (let i = 0; i < WORD_LENGTH; i++) {
        if (guessChars[i] === targetChars[i]) {
            evaluation[i] = 'correct';
            targetChars[i] = null;
            guessChars[i] = null;
        }
    }

    // Second pass: present
    for (let i = 0; i < WORD_LENGTH; i++) {
        if (guessChars[i] !== null) {
            const index = targetChars.indexOf(guessChars[i]);
            if (index !== -1) {
                evaluation[i] = 'present';
                targetChars[index] = null;
            }
        }
    }

    return evaluation;
}

function showToast(message) {
    const toast = document.getElementById('message-toast');
    toast.textContent = message;
    toast.classList.remove('hidden');
    setTimeout(() => {
        toast.classList.add('hidden');
    }, 2000);
}

// Game Logic
function handleKeyPress(key) {
    if (gameState !== 'playing') return;
    // Without the real answer there is nothing legitimate to score against —
    // a guess accepted here would be judged against the offline fallback word
    // and could commit a wrong result (see startGame, which shows the retry
    // panel instead of the board in this state).
    if (!targetWordResolved) return;
    // The submitted row stays as #active-row for the ~1s the flip animation
    // runs. Accepting input during that window let updateActiveRow() overwrite
    // the tiles being revealed (blanking the word the player just entered) and
    // could re-enter submitGuess() against the stale row.
    if (isRevealing) return;

    // Start timer on first keystroke if not already running
    if (startTime === null && key !== 'Enter' && key !== 'Backspace') {
        startTime = Date.now();
        saveState();
    }
    
    if (key === 'Enter') {
        if (currentGuess.length !== WORD_LENGTH) {
            showToast('Not enough letters');
            shakeRow();
            return;
        }
        
        if (!VALID_WORDS.has(currentGuess.toLowerCase())) {
            showToast('Not in word list');
            shakeRow();
            return;
        }
        
        submitGuess();
    } else if (key === 'Backspace') {
        currentGuess = currentGuess.slice(0, -1);
        updateActiveRow();
    } else if (/^[a-zA-Z]$/.test(key) && currentGuess.length < WORD_LENGTH) {
        currentGuess += key.toUpperCase();
        updateActiveRow();
    }
    
    saveState();
}

function shakeRow() {
    const activeRow = document.getElementById('active-row');
    if (!activeRow) return;
    activeRow.classList.remove('shake');
    void activeRow.offsetWidth; // trigger reflow
    activeRow.classList.add('shake');
}

function submitGuess() {
    const activeRow = document.getElementById('active-row');
    if (!activeRow) {
        // No row to reveal into (e.g. state was restored mid-reveal). Re-render
        // and let the next frame supply one rather than throwing.
        renderBoard();
        return;
    }
    guesses.push(currentGuess);
    const guessSubmitted = currentGuess;
    currentGuess = '';
    // Lock input until the reveal finishes (see handleKeyPress).
    isRevealing = true;
    activeRow.removeAttribute('id');

    // Flip animations
    for (let i = 0; i < WORD_LENGTH; i++) {
        const tile = activeRow.children[i];
        setTimeout(() => {
            tile.classList.add('flip');
            // Change color halfway through flip
            setTimeout(() => {
                const evaluation = evaluateGuess(guessSubmitted, targetWord);
                tile.dataset.state = evaluation[i];
                if (i === WORD_LENGTH - 1) {
                    isRevealing = false;
                    checkWinCondition();
                    if (gameState === 'playing') {
                        renderBoard(); // render next row
                    }
                }
            }, 250);
        }, i * 150);
    }
    saveState();
}

// Single source of truth for puzzle numbering. Returns null for a malformed
// game id rather than NaN or a silently wrong number.
function getPuzzleNumber(gameIdStr) {
    if (typeof gameIdStr !== 'string' || !GAME_ID_PATTERN.test(gameIdStr)) return null;

    const [year, month, day, ampm] = gameIdStr.split('-');
    const puzzleDate = Date.UTC(parseInt(year, 10), parseInt(month, 10) - 1, parseInt(day, 10));
    const diffDays = Math.round((puzzleDate - PUZZLE_EPOCH_UTC) / (1000 * 60 * 60 * 24));

    return PUZZLE_EPOCH_NUMBER + (diffDays * 2) + (ampm === 'AM' ? 0 : 1);
}

// Rebuild the streak from recorded history.
//
// `anchorPuzzle` is the puzzle the player is currently on. The recovered run
// must reach up to it (or the puzzle immediately before it, for a streak that
// is intact but today is unplayed) — otherwise the run is stale history and
// must NOT be used, or it would silently resurrect a streak that was correctly
// broken by a missed puzzle.
function autoRecoverStreak(rGames, currentStreak, anchorPuzzle) {
    if (!rGames || rGames.length === 0) return currentStreak;
    if (typeof anchorPuzzle !== 'number' || !Number.isFinite(anchorPuzzle)) return currentStreak;

    const completedPuzzles = [];
    for (let i = 0; i < rGames.length; i++) {
        const game = rGames[i];
        if (typeof game !== 'string') continue;
        if (game.includes("- X guesses")) continue;
        const match = game.match(/^#(\d+) /);
        if (match) {
            completedPuzzles.push(parseInt(match[1], 10));
        }
    }

    if (completedPuzzles.length === 0) return currentStreak;

    completedPuzzles.sort((a, b) => b - a);

    // The most recent completed puzzle must be the current one or the one right
    // before it. Anything older means at least one puzzle was missed.
    const mostRecent = completedPuzzles[0];
    if (mostRecent < anchorPuzzle - 1) return currentStreak;

    let calcStreak = 1;
    let expectedNext = mostRecent - 1;

    for (let i = 1; i < completedPuzzles.length; i++) {
        if (completedPuzzles[i] === expectedNext) {
            calcStreak++;
            expectedNext--;
        } else {
            break;
        }
    }

    // Fix for legacy capped recentGames: if the entire recorded history is consecutive,
    // it got capped at 10 (the old limit), and no games were failed,
    // their true streak may equal completedGames.
    if (calcStreak === completedPuzzles.length && calcStreak >= 10 && unfinishedGames === 0 && completedGames > calcStreak) {
        calcStreak = completedGames;
    }

    return Math.max(currentStreak, calcStreak);
}

function checkWinCondition() {
    const lastGuess = guesses[guesses.length - 1];
    if (lastGuess === targetWord) {
        gameState = 'won';
        const puzzleNum = getPuzzleNumber(gameId);
        if (puzzleNum !== null) {
            const gameIdText = `#${puzzleNum}`;
            const resultText = `${guesses.length} guesses`;
            recentGames = recentGames.filter(game => !game.startsWith(`${gameIdText} `));
            recentGames.unshift(`${gameIdText} ${targetWord} - ${resultText}`);
            if (recentGames.length > RECENT_GAMES_LIMIT) recentGames.length = RECENT_GAMES_LIMIT;
        }
        completedGames++;
        totalGuessesFinished += guesses.length;
        guessDistribution[guesses.length - 1]++;
        
        const winMessages = ['Genius!', 'Magnificent!', 'Impressive!', 'Splendid!', 'Great!', 'Phew!'];
        showToast(winMessages[guesses.length - 1] || 'Good job!');
        
        let currentStreak = parseInt(safeStorage.getItem('6lets_streak')) || 0;
        let lastCompletedPuzzle = parseInt(safeStorage.getItem('6lets_lastCompletedPuzzle')) || 0;
        
        if (puzzleNum !== null) {
            if (lastCompletedPuzzle === 0 || puzzleNum === lastCompletedPuzzle + 1) {
                // First ever solve, or the immediate next puzzle: extend the streak.
                currentStreak++;
            } else if (puzzleNum > lastCompletedPuzzle + 1) {
                // Skipped one or more puzzles: streak restarts at this solve.
                currentStreak = 1;
            } else {
                // puzzleNum <= lastCompletedPuzzle: replaying/back-filling an older
                // puzzle. Don't touch the streak (and never double-count).
            }

            currentStreak = autoRecoverStreak(recentGames, currentStreak, puzzleNum);
        }

        if (currentStreak > completedGames) {
            currentStreak = completedGames;
        }

        safeStorage.setItem('6lets_streak', currentStreak);
        if (puzzleNum !== null) {
            safeStorage.setItem('6lets_lastCompletedPuzzle', Math.max(lastCompletedPuzzle, puzzleNum));
        }
        const historyBtnText = document.getElementById('history-btn-text');
        if (historyBtnText) historyBtnText.textContent = currentStreak;
        
        safeStorage.setItem('6lets_recentGames', JSON.stringify(recentGames));
        safeStorage.setItem('6lets_completed', completedGames);
        const density = Math.max(10, 200 - (guesses.length * 15));
        if (typeof window.confetti === 'function') {
            window.confetti({ 
                particleCount: density, 
                spread: 70, 
                origin: { y: 0.6 }, 
                zIndex: 1000,
                scalar: 1.4
            });
        }
        
        updateHeaderIconToStats();
        finishGame();
    } else if (guesses.length === MAX_GUESSES) {
        gameState = 'lost';
        const puzzleNum = getPuzzleNumber(gameId);
        if (puzzleNum !== null) {
            const gameIdText = `#${puzzleNum}`;
            recentGames = recentGames.filter(game => !game.startsWith(`${gameIdText} `));
            recentGames.unshift(`${gameIdText} ${targetWord} - X guesses`);
            if (recentGames.length > RECENT_GAMES_LIMIT) recentGames.length = RECENT_GAMES_LIMIT;
        }
        unfinishedGames++;

        safeStorage.setItem('6lets_streak', 0);
        if (puzzleNum !== null) {
            // Only ever move the marker forward — replaying an older puzzle
            // must not rewind it.
            const lastCompleted = parseInt(safeStorage.getItem('6lets_lastCompletedPuzzle')) || 0;
            safeStorage.setItem('6lets_lastCompletedPuzzle', Math.max(lastCompleted, puzzleNum));
        }
        const historyBtnText = document.getElementById('history-btn-text');
        if (historyBtnText) historyBtnText.textContent = '0';
        
        showToast(`${targetWord} - Better luck next time.`);
        updateHeaderIconToStats();
        finishGame();
    }
    updateKeyboardColors();
}

function finishGame() {
    if (startTime !== null) {
        elapsedTimeMs += (Date.now() - startTime);
        startTime = null; // stop timer
    }
    
    const result = {
        user_uuid: getUserUUID(),
        game_id: gameId,
        guesses_taken: guesses.length,
        time_taken_ms: elapsedTimeMs,
        solved_successfully: gameState === 'won',
        guesses: JSON.stringify(guesses)
    };

    saveState();
    persistAggregateStats();

    // Queue offline sync. Replace any existing entry for this game rather than
    // appending — finishing the same puzzle twice (e.g. after a cloud restore)
    // used to add a duplicate every time.
    let pending;
    try {
        pending = JSON.parse(safeStorage.getItem('pending_sync') || '[]');
        if (!Array.isArray(pending)) pending = [];
    } catch (e) {
        pending = [];
    }
    pending = pending.filter(p => !(p && p.user_uuid === result.user_uuid && p.game_id === result.game_id));
    pending.push(result);
    if (pending.length > MAX_PENDING_SYNC) {
        pending = pending.slice(-MAX_PENDING_SYNC);
    }
    safeStorage.setItem('pending_sync', JSON.stringify(pending));

    syncResults(); // Try to sync immediately
    
    setTimeout(() => handlePostGame(), 1500);
}

// The graph has 11 buckets (1-10 guesses, plus a failure column). Pad short
// inputs so a 10-element distribution can't produce NaN bar heights.
const GRAPH_BUCKETS = 11;

function buildGraph(distributionData, container, textElement, highlightGameStatus = null, highlightGuessCount = 0, hideHighlight = false, wordLabel = "") {
    distributionData = Array.from({ length: GRAPH_BUCKETS }, (_, i) => Number(distributionData[i]) || 0);
    let chartData = [...distributionData];
    if (highlightGameStatus === 'won' && highlightGuessCount > 0) {
        chartData[highlightGuessCount - 1] = Math.max(1, chartData[highlightGuessCount - 1]);
    } else if (highlightGameStatus === 'lost') {
        chartData[10] = Math.max(1, chartData[10]);
    }
    
    container.innerHTML = '';
    const maxStat = Math.max(...chartData, 1); // avoid division by zero
    
    let modeIndex = 0;
    let modeValue = -1;
    for (let i = 0; i < chartData.length; i++) {
        if (chartData[i] > modeValue) {
            modeValue = chartData[i];
            modeIndex = i;
        }
    }

    const updateText = (index, showTotal = false) => {
        // Use the real distribution (not the highlight-inflated chartData) for
        // counts and percentages, so the player total isn't off by one when the
        // current player's own result isn't yet reflected in global stats.
        const total = distributionData.reduce((a, b) => a + b, 0);
        const prefix = wordLabel ? `${wordLabel} - ` : '';
        if (total === 0) {
            textElement.textContent = `${prefix}0 Players`;
            return;
        }
        if (showTotal) {
            textElement.textContent = `${prefix}${total} Player${total !== 1 ? 's' : ''}`;
            return;
        }
        const pct = Math.round((distributionData[index] / total) * 100);
        if (index === 10) {
            textElement.textContent = `${pct}% of players failed to solve this word`;
        } else {
            textElement.textContent = `${pct}% of players got this word in ${index + 1} tries`;
        }
    };

    chartData.forEach((val, i) => {
        const wrapper = document.createElement('div');
        wrapper.className = 'bar-wrapper';
        const bar = document.createElement('div');
        bar.className = 'bar';
        bar.style.height = `${(val / maxStat) * 100}%`;
        
        if (!hideHighlight) {
            // Highlight current game if applicable
            if (highlightGameStatus === 'won' && i === highlightGuessCount - 1) {
                bar.style.backgroundColor = 'var(--key-eval-correct)';
                bar.style.opacity = '1';
            } else if (highlightGameStatus === 'lost' && i === 10) {
                bar.style.backgroundColor = 'var(--key-eval-correct)';
                bar.style.opacity = '1';
            } else {
                bar.style.backgroundColor = val > 0 ? 'var(--key-eval-correct)' : 'transparent';
                bar.style.opacity = '0.4';
            }
        } else {
            // No specific user highlight for admin view
            bar.style.backgroundColor = val > 0 ? 'var(--key-eval-correct)' : 'transparent';
            bar.style.opacity = '0.8';
        }
        
        wrapper.appendChild(bar);
        wrapper.addEventListener('click', () => updateText(i));
        container.appendChild(wrapper);
    });

    // Update click listeners for labels
    const labels = container.parentElement.querySelectorAll('.guess-labels span');
    labels.forEach((label, i) => {
        const newLabel = label.cloneNode(true);
        label.parentNode.replaceChild(newLabel, label);
        newLabel.addEventListener('click', () => updateText(i));
    });

    if (modeValue > -1) {
        if (hideHighlight) {
            updateText(0, true);
        } else {
            updateText(modeIndex);
        }
    }
}

function showStatsModal() {
    const modal = document.getElementById('stats-modal');
    const overlay = document.getElementById('modal-overlay');

    // A stale popup from a previous open would sit on top of the fresh modal.
    hidePlayerGrid();

    animateBouncyWord('stats-word-container', targetWord);

    // Explain an empty/incomplete leaderboard before the player has to guess at
    // it. syncResults() also calls this, so an in-flight sync that succeeds
    // clears the banner while the modal is open.
    renderSyncWarning();

    // Stat graph update
    const allBarsContainer = document.getElementById('all-bars-container');
    const statsTextEl = document.getElementById('stats-text');
    statsTextEl.textContent = 'Calculating global stats...';
    
    const renderChart = (distributionData) => {
        buildGraph(distributionData, allBarsContainer, statsTextEl, gameState, guesses.length, false);
    };

    // Check cache first
    const cacheKey = `6lets_globalStats_${gameId}`;
    const cachedStats = safeStorage.getItem(cacheKey);
    if (cachedStats) {
        try {
            renderChart(JSON.parse(cachedStats));
        } catch(e) {
            renderChart(Array(11).fill(0));
        }
    } else {
        // Draw empty first if no cache
        renderChart(Array(11).fill(0));
    }

    // Fetch global stats in background
    fetch(`/api/game_stats?game_id=${gameId}`)
        .then(res => res.json())
        .then(data => {
            if (data.distribution) {
                renderChart(data.distribution);
                safeStorage.setItem(cacheKey, JSON.stringify(data.distribution));
            }
        })
        .catch(() => {
            if (!cachedStats) {
                const fallbackData = Array(11).fill(0);
                if (gameState === 'won') {
                    fallbackData[guesses.length - 1] = 1;
                } else if (gameState === 'lost') {
                    fallbackData[10] = 1;
                }
                renderChart(fallbackData);
            }
        });
        
    const lbContainer = document.getElementById('stats-leaderboard-container');
    const lbList = document.getElementById('stats-leaderboard');
    if (lbContainer && lbList) {
        lbContainer.style.display = 'block';
        lbList.innerHTML = '<div style="text-align: center; color: inherit;">Loading...</div>';
        
        if (!navigator.onLine) {
            lbList.innerHTML = '<div style="text-align: center; color: inherit;">Leaderboard is unavailable while offline.</div>';
        } else {
            fetch(`/api/dashboard/leaderboard?game_id=${gameId}`)
                .then(res => res.json())
                .then(data => {
                    if (data.leaderboard && data.leaderboard.length > 0) {
                        const top7 = data.leaderboard.slice(0, 7);
                        lbList.innerHTML = '';
                        top7.forEach(entry => {
                            const row = document.createElement('div');
                            row.className = 'leaderboard-row is-clickable';

                            const name = entry.display_name || 'Anonymous';
                            const statsLine = `${entry.guesses_taken} guess${entry.guesses_taken > 1 ? 'es' : ''} - ${formatTimeMs(entry.time_taken_ms)}`;

                            const nameDiv = document.createElement('div');
                            nameDiv.className = 'leaderboard-name';
                            nameDiv.textContent = name;

                            const statsDiv = document.createElement('div');
                            statsDiv.className = 'leaderboard-stats';
                            statsDiv.textContent = statsLine;

                            row.appendChild(nameDiv);
                            row.appendChild(statsDiv);

                            // Keyboard parity with the pointer affordance: the row
                            // looks like plain text, so without this it would be
                            // unreachable for anyone not using a mouse.
                            row.tabIndex = 0;
                            row.setAttribute('role', 'button');
                            row.setAttribute('aria-label', `${name}, ${statsLine}. Show guess grid.`);
                            row.addEventListener('click', () => {
                                showPlayerGrid(name, statsLine, entry.pattern);
                            });
                            row.addEventListener('keydown', (e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault();
                                    showPlayerGrid(name, statsLine, entry.pattern);
                                }
                            });

                            lbList.appendChild(row);
                        });
                    } else {
                        lbList.innerHTML = '<div style="text-align: center; color: inherit;">No players yet.</div>';
                    }
                })
                .catch(() => {
                    lbList.innerHTML = '<div style="text-align: center; color: inherit;">Failed to load leaderboard.</div>';
                });
        }
    }

    modal.classList.remove('hidden');
    overlay.classList.remove('hidden');
}

// Shows one leaderboard player's guess grid on top of the stats modal.
//
// `pattern` is the emoji grid the leaderboard API derives server-side. It is
// null for results saved before guesses were stored (and for any blob that
// failed validation), so the empty case is normal, not an error.
function showPlayerGrid(name, statsLine, pattern) {
    const popup = document.getElementById('player-grid-popup');
    if (!popup) return;

    document.getElementById('player-grid-name').textContent = name;
    document.getElementById('player-grid-stats').textContent = statsLine;

    const rowsEl = document.getElementById('player-grid-rows');
    if (Array.isArray(pattern) && pattern.length > 0) {
        rowsEl.classList.remove('no-grid');
        rowsEl.textContent = pattern.join('\n');
    } else {
        rowsEl.classList.add('no-grid');
        rowsEl.textContent = 'No grid saved for this game.';
    }

    popup.classList.remove('hidden');
    document.getElementById('close-player-grid-btn').focus();
}

function hidePlayerGrid() {
    const popup = document.getElementById('player-grid-popup');
    if (popup) popup.classList.add('hidden');
}

document.getElementById('close-player-grid-btn').addEventListener('click', hidePlayerGrid);

// Tapping the dimmed area closes it; clicks inside the card must not bubble out
// and dismiss the thing the player is trying to read.
document.getElementById('player-grid-popup').addEventListener('click', (e) => {
    if (e.target.id === 'player-grid-popup') hidePlayerGrid();
});

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hidePlayerGrid();
});

// Targeted by id — `document.querySelector('.close-btn')` happened to match the
// stats modal only because it sits first in the DOM.
document.getElementById('close-stats-btn').addEventListener('click', () => {
    // The popup lives outside #stats-modal, so hiding the modal alone would
    // leave it floating over the board.
    hidePlayerGrid();
    document.getElementById('stats-modal').classList.add('hidden');
    document.getElementById('modal-overlay').classList.add('hidden');
});

const getShareText = () => {
    const options = { month: 'short', day: '2-digit', year: 'numeric' };
    // Derive the date from the puzzle's game id (LA date) rather than the
    // device's local clock, so the shared date always matches the puzzle number.
    const gameIdParts = (gameId || '').split('-');
    let shareDate = new Date();
    if (gameIdParts.length === 4) {
        shareDate = new Date(parseInt(gameIdParts[0]), parseInt(gameIdParts[1]) - 1, parseInt(gameIdParts[2]));
    }
    const dateString = shareDate.toLocaleDateString('en-US', options);

    let emojiGrid = '';
    guesses.forEach(guess => {
        let row = '';
        let targetChars = targetWord.split('');
        let statuses = Array(6).fill('absent');
        
        for (let i = 0; i < 6; i++) {
            if (guess[i] === targetChars[i]) {
                statuses[i] = 'correct';
                targetChars[i] = null;
            }
        }
        for (let i = 0; i < 6; i++) {
            if (statuses[i] !== 'correct' && targetChars.includes(guess[i])) {
                statuses[i] = 'present';
                targetChars[targetChars.indexOf(guess[i])] = null;
            }
        }
        
        statuses.forEach(status => {
            if (status === 'correct') row += '🟩';
            else if (status === 'present') row += '🟨';
            else row += '⬛';
        });
        emojiGrid += row + '\n';
    });
    
    const puzzleNum = getPuzzleNumber(gameId);
    const puzzleLabel = puzzleNum === null ? dateString : `${dateString} (#${puzzleNum})`;
    return `Six Letters\n${puzzleLabel}\n${emojiGrid}https://6lets.com/`;
};

const copyToClipboard = (textToShare) => {
    const fallbackCopy = () => {
        const textarea = document.createElement('textarea');
        textarea.value = textToShare;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        try {
            document.execCommand('copy');
            showToast('Copied results to clipboard');
        } catch (e) {
            showToast('Unable to copy');
        }
        document.body.removeChild(textarea);
    };

    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(textToShare).then(() => {
            showToast('Copied results to clipboard');
        }).catch(() => fallbackCopy());
    } else {
        fallbackCopy();
    }
};

const copyBtn = document.getElementById('copy-btn');
if (copyBtn) {
    copyBtn.addEventListener('click', () => {
        const textToShare = getShareText();
        copyToClipboard(textToShare);
    });
}

const shareBtn = document.getElementById('share-btn');
if (shareBtn) {
    shareBtn.addEventListener('click', async () => {
        const textToShare = getShareText();
        if (navigator.share) {
            try {
                await navigator.share({
                    title: 'Six Letters',
                    text: textToShare
                });
            } catch (e) {
                // Ignore abort errors when user closes share sheet
            }
        } else {
            copyToClipboard(textToShare);
        }
    });
}


document.getElementById('close-history-x-btn').addEventListener('click', () => {
    document.getElementById('history-modal').classList.add('hidden');
    document.getElementById('modal-overlay').classList.add('hidden');
});

document.getElementById('close-history-btn').addEventListener('click', () => {
    document.getElementById('history-modal').classList.add('hidden');
    document.getElementById('modal-overlay').classList.add('hidden');
});

// History Modal trigger
const historyBtn = document.getElementById('history-btn-header');
if (historyBtn) {
    historyBtn.addEventListener('click', showHistoryModal);
} else {
    // Fallback if index.html is cached
    const titleEl = document.querySelector('.title');
    if (titleEl) {
        titleEl.addEventListener('click', showHistoryModal);
        titleEl.style.cursor = 'pointer';
    }
}

function animateBouncyWord(containerId, text = "SIXLETTERS") {
    const container = document.getElementById(containerId);
    container.innerHTML = '';
    for (let i = 0; i < text.length; i++) {
        const tile = document.createElement('div');
        tile.className = 'tile bouncy';
        tile.style.animationDelay = `${(i / 20).toFixed(2)}s`;
        tile.textContent = text[i];
        if (text[i] === ' ') {
            tile.style.background = 'transparent';
            tile.style.border = 'none';
            tile.style.boxShadow = 'none';
        } else {
            tile.style.backgroundColor = 'var(--key-eval-correct)';
        }
        container.appendChild(tile);
    }
}

function showHistoryModal() {
    document.getElementById('history-modal').classList.remove('hidden');
    document.getElementById('modal-overlay').classList.remove('hidden');
    
    // Animate SIXLETTERS
    animateBouncyWord('history-word-container');
    
    // Stats
    const avg = completedGames > 0 ? (totalGuessesFinished / completedGames).toFixed(3) : '0';
    document.getElementById('hist-avg').textContent = `Average guesses: ${avg}`;
    document.getElementById('hist-completed').textContent = `Completed games: ${completedGames}`;
    document.getElementById('hist-unfinished').textContent = `Unfinished games: ${unfinishedGames}`;
    
    const streak = parseInt(safeStorage.getItem('6lets_streak')) || 0;
    const puzzleStr = streak === 1 ? 'consecutive puzzle' : 'consecutive puzzles';
    document.getElementById('hist-streak').textContent = `Streak: ${streak} ${puzzleStr}`;
    
    // Recent games
    const listContainer = document.getElementById('recent-games-list');
    listContainer.innerHTML = '';
    
    const uniqueGames = [];
    const seenPuzzlesUI = new Set();
    recentGames.forEach(game => {
        const match = game.match(/(#\d+)/);
        if (match) {
            if (!seenPuzzlesUI.has(match[1])) {
                seenPuzzlesUI.add(match[1]);
                uniqueGames.push(game);
            }
        } else {
            uniqueGames.push(game);
        }
    });

    uniqueGames.forEach(game => {
        const div = document.createElement('div');
        div.textContent = game;
        listContainer.appendChild(div);
    });
    if (uniqueGames.length === 0) {
        listContainer.textContent = "No recent games yet.";
    }
}

function updateHeaderIconToStats() {
    const helpBtn = document.getElementById('help-btn-header');
    if (helpBtn) {
        helpBtn.innerHTML = `
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="20" x2="18" y2="10"></line>
                <line x1="12" y1="20" x2="12" y2="4"></line>
                <line x1="6" y1="20" x2="6" y2="14"></line>
            </svg>
        `;
        helpBtn.setAttribute('aria-label', 'Stats');
    }
}

// Help Modal handling
document.getElementById('help-btn-header').addEventListener('click', () => {
    if (gameState === 'won' || gameState === 'lost') {
        handlePostGame();
    } else {
        document.getElementById('help-modal').classList.remove('hidden');
        document.getElementById('modal-overlay').classList.remove('hidden');
        animateBouncyWord('help-word-container');
    }
});

document.getElementById('close-help-btn').addEventListener('click', () => {
    document.getElementById('help-modal').classList.add('hidden');
    document.getElementById('modal-overlay').classList.add('hidden');
});

// State Management

// Per-puzzle keys ('gameState_<id>' and '6lets_globalStats_<id>') accumulate at
// four a day and were never cleaned up. safeStorage swallows
// QuotaExceededError, so the eventual failure mode is state silently ceasing to
// save — prune old ones instead.
function listStorageKeys() {
    try {
        return Object.keys(window.localStorage);
    } catch (e) {
        return [];
    }
}

function clearAllGameStateKeys() {
    listStorageKeys()
        .filter(key => key.startsWith('gameState_'))
        .forEach(key => safeStorage.removeItem(key));
}

function pruneOldStorageKeys(keepGameIds) {
    const keep = new Set(keepGameIds.filter(Boolean));
    listStorageKeys().forEach(key => {
        let id = null;
        if (key.startsWith('gameState_')) id = key.slice('gameState_'.length);
        else if (key.startsWith('6lets_globalStats_')) id = key.slice('6lets_globalStats_'.length);

        if (id !== null && !keep.has(id)) {
            safeStorage.removeItem(key);
        }
    });
}

// Aggregates only change when a game finishes, so they don't belong in the
// per-keystroke write path.
function persistAggregateStats() {
    safeStorage.setItem('6lets_distribution', JSON.stringify(guessDistribution));
    safeStorage.setItem('6lets_completed', completedGames);
    safeStorage.setItem('6lets_unfinished', unfinishedGames);
    safeStorage.setItem('6lets_totalGuesses', totalGuessesFinished);
    safeStorage.setItem('6lets_recentGames', JSON.stringify(recentGames));
}

function saveState() {
    const state = {
        guesses,
        currentGuess,
        gameState,
        elapsedTimeMs,
        startTime,
        lastSaved: Date.now()
    };
    safeStorage.setItem(`gameState_${gameId}`, JSON.stringify(state));
}

function readSavedGameState(id) {
    const raw = safeStorage.getItem(`gameState_${id}`);
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw);
        return (parsed && typeof parsed === 'object') ? parsed : null;
    } catch (e) {
        console.warn('Could not parse saved game state for', id, e);
        return null;
    }
}

function loadState() {
    gameId = getGameId();
    
    const lastGameId = safeStorage.getItem('6lets_lastGameId');
    if (lastGameId && lastGameId !== gameId) {
        const lastStateStr = safeStorage.getItem(`gameState_${lastGameId}`);
        if (lastStateStr) {
            try {
                const lastState = JSON.parse(lastStateStr);
                if (lastState.gameState === 'playing' && lastState.guesses && lastState.guesses.length > 0) {
                    unfinishedGames++;
                    safeStorage.setItem('6lets_unfinished', unfinishedGames);
                    lastState.gameState = 'lost';
                    safeStorage.setItem(`gameState_${lastGameId}`, JSON.stringify(lastState));
                }
            } catch (e) {
                console.warn('Could not parse previous game state', e);
            }
        }
    }
    safeStorage.setItem('6lets_lastGameId', gameId);

    // Only the current and immediately previous puzzle are ever read back.
    pruneOldStorageKeys([gameId, lastGameId]);

    const savedState = readSavedGameState(gameId);
    if (savedState) {
        guesses = savedState.guesses || [];
        currentGuess = savedState.currentGuess || '';
        gameState = savedState.gameState || 'playing';
        elapsedTimeMs = savedState.elapsedTimeMs || 0;

        // Never resume a persisted startTime. If the browser was force-killed
        // (or backgrounded in a way that never fired visibilitychange), it can
        // be hours or days old, and finishGame() would add that entire absence
        // to the player's time. Only the segment we can actually verify — from
        // the start marker to the last save — is banked; the clock then
        // restarts on the next keystroke.
        const savedStart = savedState.startTime || null;
        const lastSaved = savedState.lastSaved || 0;
        if (savedStart !== null && lastSaved > savedStart) {
            elapsedTimeMs += (lastSaved - savedStart);
        }
        startTime = null;
    }

    // Check if missed a puzzle to break streak
    let currentStreak = parseInt(safeStorage.getItem('6lets_streak')) || 0;
    let lastCompletedPuzzle = parseInt(safeStorage.getItem('6lets_lastCompletedPuzzle')) || 0;
    const currentPuzzle = getPuzzleNumber(gameId);
    
    if (gameState === 'playing' && currentPuzzle !== null && lastCompletedPuzzle > 0 && currentPuzzle > lastCompletedPuzzle + 1) {
        safeStorage.setItem('6lets_streak', 0);
        currentStreak = 0;

        if (recentGames.length > RECENT_GAMES_LIMIT) {
            recentGames.length = RECENT_GAMES_LIMIT;
            safeStorage.setItem('6lets_recentGames', JSON.stringify(recentGames));
        }
    }

    // Auto-recover the streak from recent games if it was incorrectly lost.
    // Anchored to the current puzzle: without that anchor this ran right after
    // the reset above and simply restored the streak it had just broken, since
    // the old consecutive run is still sitting in recentGames.
    const recentGamesStr = safeStorage.getItem('6lets_recentGames');
    if (recentGamesStr && currentPuzzle !== null) {
        try {
            const rGames = JSON.parse(recentGamesStr);
            const calcStreak = autoRecoverStreak(rGames, 0, currentPuzzle);
            if (calcStreak > currentStreak) {
                currentStreak = calcStreak;
                safeStorage.setItem('6lets_streak', currentStreak);
            }
        } catch (e) {
            console.warn('Could not parse recent games', e);
        }
    }
    
    const historyBtnText = document.getElementById('history-btn-text');
    if (historyBtnText) historyBtnText.textContent = currentStreak;
}

// Pause the timer whenever the page goes away. `pagehide` covers the cases
// visibilitychange misses — notably iOS Safari tab teardown and bfcache entry.
function pauseTimer() {
    if (gameState !== 'playing') return;
    if (startTime === null) return;
    elapsedTimeMs += (Date.now() - startTime);
    startTime = null;
    saveState();
}

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
        pauseTimer();
    }
    // We do not resume startTime on 'visible'. We wait for the next keystroke
    // as per requirements.
});

window.addEventListener('pagehide', pauseTimer);

// Setup Physical Keyboard
document.addEventListener('keydown', (e) => {
    // Ignore keypresses if the user is typing in an input field
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    
    // Ignore keypresses if any modal is open
    const modalOverlay = document.getElementById('modal-overlay');
    if (modalOverlay && !modalOverlay.classList.contains('hidden')) return;
    
    // Ignore keyboard shortcuts (like Ctrl+V)
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    if (e.key === 'Enter' || e.key === 'Backspace' || /^[a-zA-Z]$/.test(e.key)) {
        handleKeyPress(e.key);
    }
});

// Sync health
//
// A failed POST /api/results is invisible to everyone. The queue sits in
// localStorage and retries quietly, so the player sees a leaderboard that is
// simply missing them, and we see nothing at all. On 2026-07-25 a dropped index
// made every write 500 for ~26 hours; the only signal that reached us was
// players saying "the leaderboard is broken". Count consecutive failures and
// put the reason on screen, where the absence is already being noticed.
const SYNC_FAILURE_WARN_THRESHOLD = 3;

function getSyncFailureState() {
    return {
        count: parseInt(safeStorage.getItem('6lets_syncFailCount'), 10) || 0,
        since: safeStorage.getItem('6lets_syncFailSince') || null,
        // A 4xx discards the queue outright — those results are gone, not
        // merely delayed, so it warrants a different message.
        rejected: safeStorage.getItem('6lets_syncRejected') === 'true'
    };
}

function clearSyncFailure() {
    safeStorage.removeItem('6lets_syncFailCount');
    safeStorage.removeItem('6lets_syncFailSince');
    safeStorage.removeItem('6lets_syncRejected');
}

function recordSyncFailure(rejected = false) {
    const { count, since } = getSyncFailureState();
    safeStorage.setItem('6lets_syncFailCount', String(count + 1));
    // Keep the first failure's timestamp so we can say how long it has been.
    if (!since) safeStorage.setItem('6lets_syncFailSince', new Date().toISOString());
    if (rejected) safeStorage.setItem('6lets_syncRejected', 'true');
}

// Null when there is nothing worth saying. Below the threshold we stay quiet:
// one failed sync is usually a flaky connection, not an outage.
function getSyncWarning() {
    const { count, since, rejected } = getSyncFailureState();

    // A rejection is permanent loss, not a transient outage, so it is worth
    // saying the first time rather than waiting for the threshold.
    if (rejected) {
        return 'Your recent scores could not be saved and will not appear on the leaderboard.';
    }

    if (count < SYNC_FAILURE_WARN_THRESHOLD) return null;

    let elapsed = '';
    if (since) {
        const ms = Date.now() - new Date(since).getTime();
        const hours = Math.floor(ms / 3600000);
        if (hours >= 24) {
            const days = Math.floor(hours / 24);
            elapsed = ` for ${days} day${days === 1 ? '' : 's'}`;
        } else if (hours >= 1) {
            elapsed = ` for ${hours} hour${hours === 1 ? '' : 's'}`;
        }
    }

    return `Scores haven't reached the server${elapsed}. Your games are saved on this device and will appear on the leaderboard once it's back.`;
}

function renderSyncWarning() {
    const el = document.getElementById('sync-warning');
    if (!el) return;

    const message = getSyncWarning();
    if (!message) {
        el.classList.add('hidden');
        el.textContent = '';
        return;
    }

    el.textContent = message;
    el.classList.remove('hidden');
}

// Sync logic
// Returns true when the local queue is known to be flushed to the server
// (either it was empty, or the POST succeeded), false otherwise.
async function syncResults() {
    if (!navigator.onLine) return false;

    let pending;
    try {
        pending = JSON.parse(safeStorage.getItem('pending_sync') || '[]');
        if (!Array.isArray(pending)) pending = [];
    } catch (e) {
        safeStorage.setItem('pending_sync', '[]');
        return true;
    }
    if (pending.length === 0) {
        // Nothing outstanding, so any recorded failure is resolved. This is
        // also what retires the 4xx banner: a rejection empties the queue, so
        // the warning shows on the post-game modal and is cleared on the next
        // load rather than sticking to the modal forever.
        clearSyncFailure();
        return true;
    }

    try {
        // The server only reads `pending`; aggregate stats are recomputed
        // server-side from the Results table, so we don't send them.
        const response = await fetch('/api/results', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pending })
        });

        if (response.ok) {
            // The server validates and drops bad records rather than failing
            // the request, so a 2xx means "everything processable was
            // processed" — safe to clear.
            safeStorage.setItem('pending_sync', '[]');
            clearSyncFailure();
            renderSyncWarning();
            return true;
        }

        // A 4xx means the payload will never be accepted; retrying it forever
        // would block every later result behind it. Only retry on 5xx.
        if (response.status >= 400 && response.status < 500) {
            console.warn('Server rejected pending results; discarding queue.');
            safeStorage.setItem('pending_sync', '[]');
            recordSyncFailure(true);
        } else {
            recordSyncFailure();
        }
        renderSyncWarning();
        return false;
    } catch (e) {
        console.error('Failed to sync', e);
        // Don't count a request that failed because the device dropped offline
        // mid-flight — that is not a server problem and resolves itself.
        if (navigator.onLine) {
            recordSyncFailure();
            renderSyncWarning();
        }
    }
    return false;
}

function readOfflineWords() {
    try {
        const parsed = JSON.parse(safeStorage.getItem('offline_words') || '[]');
        return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
        return [];
    }
}

// Shared with sw.js — the service worker refreshes this cache from periodic
// background sync; the page mirrors its own successful fetches into it and
// falls back to it when the network is down. Keep the names in sync.
const WORDS_CACHE_NAME = 'sixlets-words-v1';
const WORDS_URL = '/api/words';

// Array items are { id, word: base64 } for the plaintext tier and
// { id, sealed: {...} } for the extended tier (see resolveSealedWord).
async function fetchOfflineWords() {
    let data = null;

    try {
        const response = await fetch(WORDS_URL);
        if (response.ok) {
            const parsed = await response.json();
            // Never let a degraded response clobber a good cache. An empty
            // list means "we couldn't tell you" far more often than "there
            // are no words", and overwriting on it drops every player onto
            // the retry panel mid-game.
            if (Array.isArray(parsed) && parsed.length > 0) {
                data = parsed;
                // Mirror into the words cache so this copy and the service
                // worker's background-refreshed one are the same store.
                if (typeof caches !== 'undefined') {
                    try {
                        const cache = await caches.open(WORDS_CACHE_NAME);
                        await cache.put(WORDS_URL, new Response(JSON.stringify(parsed), {
                            headers: { 'Content-Type': 'application/json' }
                        }));
                    } catch (e) {
                        console.warn('Could not mirror words into cache', e);
                    }
                }
            } else if (Array.isArray(parsed)) {
                console.warn('Word list came back empty; keeping cached words.');
            }
        }
    } catch (e) {
        console.error('Failed to fetch offline words', e);
    }

    // Offline or failed: the service worker may have background-refreshed the
    // cache more recently than localStorage was written.
    if (!data && typeof caches !== 'undefined') {
        try {
            const cache = await caches.open(WORDS_CACHE_NAME);
            const cached = await cache.match(WORDS_URL);
            if (cached) {
                const parsed = await cached.json();
                if (Array.isArray(parsed) && parsed.length > 0) data = parsed;
            }
        } catch (e) {
            console.warn('Could not read cached words', e);
        }
    }

    if (data) safeStorage.setItem('offline_words', JSON.stringify(data));
}

// Mirrors lib/wordseal.js on the server — keep the two in sync. Recovers the
// withheld low bits of the key by brute force (~2^bits hashes against the
// verifier), then decrypts. Yields to the event loop periodically so the
// search never janks the page.
async function unsealWord(sealed) {
    const b64bytes = (str) => {
        const bin = atob(str);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    };

    const partial = b64bytes(sealed.key);
    const verifier = b64bytes(sealed.v);
    const packed = b64bytes(sealed.ct);
    const iv = packed.slice(0, 12);
    const ct = packed.slice(12);

    const max = 1 << sealed.bits;
    const cand = new Uint8Array(partial);
    for (let v = 0; v < max; v++) {
        if ((v & 2047) === 2047) await new Promise(r => setTimeout(r, 0));

        cand[31] = v & 0xff;
        if (sealed.bits > 8) cand[30] = partial[30] | ((v >> 8) & 0xff);

        const h = new Uint8Array(await crypto.subtle.digest('SHA-256', cand));
        let match = true;
        for (let i = 0; i < 32; i++) {
            if (h[i] !== verifier[i]) { match = false; break; }
        }
        if (!match) continue;

        const key = await crypto.subtle.importKey('raw', cand, 'AES-GCM', false, ['decrypt']);
        const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
        return new TextDecoder().decode(plain);
    }
    return null;
}

// The extended tier: if today's word is only cached sealed, unseal it (a
// sub-second one-off) and rewrite the cache entry as plaintext so every later
// load of this game is instant.
async function resolveSealedWord() {
    if (targetWordResolved) return;

    const entry = readOfflineWords().find(w => w && w.id === gameId && w.sealed);
    if (!entry) return;

    try {
        const word = (await unsealWord(entry.sealed) || '').toUpperCase();
        if (word.length !== WORD_LENGTH) {
            console.warn('Unsealed word for', gameId, 'is not', WORD_LENGTH, 'letters.');
            return;
        }

        targetWord = word;
        targetWordResolved = true;

        const rewritten = readOfflineWords().map(w =>
            (w && w.id === gameId) ? { id: gameId, word: btoa(word) } : w);
        safeStorage.setItem('offline_words', JSON.stringify(rewritten));
    } catch (e) {
        console.warn('Could not unseal word for', gameId, e);
    }
}

// Ask the browser to top up the word cache roughly daily even when the app is
// closed (Chromium installed-PWA feature; a no-op elsewhere, where page-load
// fetches do the refreshing).
async function registerWordRefresh() {
    try {
        if (!('serviceWorker' in navigator)) return;
        const registration = await navigator.serviceWorker.ready;
        if (!('periodicSync' in registration)) return;
        await registration.periodicSync.register('refresh-words', {
            minInterval: 12 * 60 * 60 * 1000
        });
    } catch (e) {
        // Permission or support missing — fine, the app still refreshes on
        // every open.
    }
}

// A guess is pushed and saved immediately, but the win/loss check only runs
// after the ~1s flip reveal. If the page unloads inside that window the state
// persists as 'playing' with a decided board — leaving a game that can never be
// completed (and, on the 10th guess, no active row to type into). Resolve it on
// load, once the target word is known.
// Returns true if it resolved the game (finishGame will then have scheduled the
// post-game modal itself).
function resolveInterruptedGame() {
    if (gameState !== 'playing' || guesses.length === 0) return false;

    // Only safe once the real answer is known. Against the offline fallback
    // word we would commit a wrong result — a loss recorded with the wrong word
    // in history, or a bogus win — and it would be unrecoverable.
    if (!targetWordResolved) return false;

    const lastGuess = guesses[guesses.length - 1];
    if (lastGuess === targetWord || guesses.length >= MAX_GUESSES) {
        checkWinCondition();
        return gameState !== 'playing';
    }
    return false;
}

function determineTargetWord() {
    // Plaintext entries only — sealed ones are resolveSealedWord's job.
    const match = readOfflineWords().find(w => w && w.id === gameId && w.word);
    if (!match) {
        console.warn('No plaintext word cached for', gameId);
        return;
    }

    try {
        const decoded = atob(match.word).toUpperCase();
        if (decoded.length === WORD_LENGTH) {
            targetWord = decoded;
            targetWordResolved = true;
        } else {
            console.warn('Cached word for', gameId, 'is not', WORD_LENGTH, 'letters.');
        }
    } catch (e) {
        // A corrupt cache entry used to throw out of the init chain, leaving
        // the board unrendered.
        console.warn('Could not decode cached word for', gameId, e);
    }
}

// Sync Down logic
async function syncDown(force = false) {
    if (!navigator.onLine) return;
    try {
        const uuid = getUserUUID();
        const response = await fetch(`/api/user?uuid=${uuid}&game_id=${gameId}`);
        if (response.ok) {
            const stats = await response.json();

            const serverDist = JSON.parse(stats['6lets_distribution'] || '[0,0,0,0,0,0,0,0,0,0]');
            const serverCompleted = stats['6lets_completed'] || 0;
            const serverUnfinished = stats['6lets_unfinished'] || 0;
            const serverTotalGuesses = stats['6lets_totalGuesses'] || 0;
            const serverRecent = JSON.parse(stats['6lets_recentGames'] || '[]');

            // Guard against clobbering newer local (offline) progress with an
            // older server snapshot — e.g. if the preceding upload silently
            // failed. On an explicit account switch (force) we always adopt the
            // server state for the new account.
            const localPlayed = completedGames + unfinishedGames;
            const serverPlayed = serverCompleted + serverUnfinished;
            const adoptedServerSnapshot = force || serverPlayed >= localPlayed;
            if (adoptedServerSnapshot) {
                guessDistribution = serverDist;
                completedGames = serverCompleted;
                unfinishedGames = serverUnfinished;
                totalGuessesFinished = serverTotalGuesses;
                recentGames = serverRecent;

                safeStorage.setItem('6lets_distribution', JSON.stringify(guessDistribution));
                safeStorage.setItem('6lets_completed', completedGames);
                safeStorage.setItem('6lets_unfinished', unfinishedGames);
                safeStorage.setItem('6lets_totalGuesses', totalGuessesFinished);
                safeStorage.setItem('6lets_recentGames', JSON.stringify(recentGames));
            }

            let currentStreak = parseInt(safeStorage.getItem('6lets_streak')) || 0;
            if (currentStreak > completedGames) {
                currentStreak = completedGames;
                safeStorage.setItem('6lets_streak', currentStreak);
                const historyBtnText = document.getElementById('history-btn-text');
                if (historyBtnText) historyBtnText.textContent = currentStreak;
            }

            if (stats.display_name !== undefined) {
                safeStorage.setItem('6lets_display_name', stats.display_name);
            }

            // Sync current game board state if completed in cloud. Only when we
            // also took the server's aggregate snapshot — otherwise the board
            // would show as finished while the local counters, which we kept
            // because they were ahead, know nothing about it.
            if (stats.cloud_gameState && adoptedServerSnapshot && (gameState === 'playing' || force)) {
                gameState = stats.cloud_gameState;
                if (stats.cloud_guesses) {
                    guesses = JSON.parse(stats.cloud_guesses);
                }
                if (stats.cloud_timeTakenMs) {
                    elapsedTimeMs = stats.cloud_timeTakenMs;
                }
                saveState();
                renderBoard();
                setTimeout(handlePostGame, 1500);
            }
        }
    } catch (e) {
        console.error('Error syncing down:', e);
    }
}

// Admin Easter Egg
let titleClickCount = 0;
const titleEl = document.querySelector('.title');
if (titleEl) {
    titleEl.addEventListener('click', () => {
        titleClickCount++;
        if (titleClickCount === 10) {
            safeStorage.setItem('isAdmin', 'true');
            const adminBtn = document.getElementById('admin-btn-header');
            if (adminBtn) adminBtn.style.display = 'flex';

        }
    });
}

if (safeStorage.getItem('isAdmin') === 'true') {
    const adminBtn = document.getElementById('admin-btn-header');
    if (adminBtn) adminBtn.style.display = 'flex';
}

const adminBtn = document.getElementById('admin-btn-header');
if (adminBtn) {
    adminBtn.addEventListener('click', () => {
        if (safeStorage.getItem('hasAdminSession') === 'true') {
            document.getElementById('modal-overlay').classList.remove('hidden');
            openDashboard();
        } else {
            document.getElementById('admin-login-modal').classList.remove('hidden');
            document.getElementById('modal-overlay').classList.remove('hidden');
            animateBouncyWord('admin-login-word-container', 'ADMIN');
        }
    });
}

document.getElementById('close-admin-login-btn').addEventListener('click', () => {
    document.getElementById('admin-login-modal').classList.add('hidden');
    document.getElementById('modal-overlay').classList.add('hidden');
});

// Admin Login submit is handled later in the file

// Settings Modal handling
document.getElementById('settings-btn-header').addEventListener('click', () => {
    document.getElementById('settings-modal').classList.remove('hidden');
    document.getElementById('modal-overlay').classList.remove('hidden');
    
    animateBouncyWord('settings-word-container', 'SETTINGS');

    const currentDisplayName = safeStorage.getItem('6lets_display_name') || '';
    const dnInput = document.getElementById('display-name-input');
    const updateDnBtn = document.getElementById('update-display-name-btn');
    
    dnInput.value = currentDisplayName;
    updateDnBtn.style.display = 'none';

    const uuidInput = document.getElementById('uuid-input');
    uuidInput.value = getUserUUID();
    document.getElementById('update-uuid-btn').style.display = 'none';

    const themeSelector = document.getElementById('theme-selector');
    themeSelector.value = safeStorage.getItem('6lets_theme') || 'original';
});

document.getElementById('display-name-input').addEventListener('input', (e) => {
    const val = e.target.value.trim();
    const currentDisplayName = safeStorage.getItem('6lets_display_name') || '';
    const updateDnBtn = document.getElementById('update-display-name-btn');
    if (val === '' || val === currentDisplayName) {
        updateDnBtn.style.display = 'none';
    } else {
        updateDnBtn.style.display = 'inline-block';
    }
});

document.getElementById('theme-selector').addEventListener('change', (e) => {
    const theme = e.target.value;
    safeStorage.setItem('6lets_theme', theme);
    document.documentElement.setAttribute('data-theme', theme);
});

document.getElementById('update-display-name-btn').addEventListener('click', async () => {
    const dnInput = document.getElementById('display-name-input');
    const updateDnBtn = document.getElementById('update-display-name-btn');
    const val = dnInput.value.trim();
    
    if (!navigator.onLine) {
        showToast('Cannot change display name while offline');
        return;
    }
    
    try {
        updateDnBtn.disabled = true;
        updateDnBtn.textContent = 'Updating...';
        
        const res = await fetch('/api/user', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ uuid: getUserUUID(), display_name: val })
        });
        
        updateDnBtn.textContent = 'Update';
        updateDnBtn.disabled = false;

        if (res.ok) {
            safeStorage.setItem('6lets_display_name', val);
            updateDnBtn.style.display = 'none';
            showToast('Display name updated');
        } else {
            const data = await res.json().catch(() => ({}));
            showToast(data.error || 'Failed to update name');
        }
    } catch (e) {
        updateDnBtn.textContent = 'Update';
        updateDnBtn.disabled = false;
        showToast('Error updating name');
    }
});

document.getElementById('close-settings-x').addEventListener('click', () => {
    document.getElementById('settings-modal').classList.add('hidden');
    document.getElementById('modal-overlay').classList.add('hidden');
});

document.getElementById('close-settings-btn').addEventListener('click', () => {
    document.getElementById('settings-modal').classList.add('hidden');
    document.getElementById('modal-overlay').classList.add('hidden');
});

document.getElementById('copy-uuid-btn').addEventListener('click', () => {
    const uuidInput = document.getElementById('uuid-input');
    
    const fallbackCopy = () => {
        uuidInput.select();
        uuidInput.setSelectionRange(0, 99999);
        try {
            if (document.execCommand('copy')) {
                showToast('Copied to clipboard');
            } else {
                showToast('Unable to copy');
            }
        } catch (err) {
            showToast('Unable to copy');
        }
        window.getSelection().removeAllRanges();
    };

    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(uuidInput.value).then(() => {
            showToast('Copied to clipboard');
        }).catch(() => fallbackCopy());
    } else {
        fallbackCopy();
    }
});

document.getElementById('paste-uuid-btn').addEventListener('click', async () => {
    const uuidInput = document.getElementById('uuid-input');
    
    if (navigator.clipboard && window.isSecureContext) {
        try {
            const text = await navigator.clipboard.readText();
            uuidInput.value = text.trim();
            checkUUIDInput();
            return;
        } catch (e) {
            // Fall through if permission denied or unsupported
        }
    }
    
    uuidInput.focus();
    try {
        if (document.execCommand('paste')) {
            checkUUIDInput();
        } else {
            showToast('Tap field & paste manually');
        }
    } catch (e) {
        showToast('Tap field & paste manually');
    }
});

function checkUUIDInput() {
    const uuidInput = document.getElementById('uuid-input');
    const updateBtn = document.getElementById('update-uuid-btn');
    const currentUUID = getUserUUID();
    const newValue = uuidInput.value.trim();
    
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    
    if (uuidRegex.test(newValue) && newValue !== currentUUID) {
        updateBtn.style.display = 'block';
    } else {
        updateBtn.style.display = 'none';
    }
}
document.getElementById('uuid-input').addEventListener('input', checkUUIDInput);

document.getElementById('update-uuid-btn').addEventListener('click', async () => {
    const newValue = document.getElementById('uuid-input').value.trim();
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    
    if (uuidRegex.test(newValue)) {
        safeStorage.setItem('6lets_uuid', newValue);

        // Wipe local game state so the new UUID's state loads cleanly. These
        // used to remove '6lets_gameState' / '6lets_guesses' /
        // '6lets_elapsedTimeMs', none of which are real keys — the actual key
        // is `gameState_${gameId}`, so the incoming account inherited the
        // previous player's board.
        clearAllGameStateKeys();
        safeStorage.removeItem('6lets_lastGameId');
        safeStorage.removeItem('6lets_display_name');
        gameState = 'playing';
        guesses = [];
        currentGuess = '';
        elapsedTimeMs = 0;
        startTime = null;

        document.getElementById('update-uuid-btn').style.display = 'none';
        showToast('Player ID updated. Syncing...');
        await syncResults();
        await syncDown(true);
        document.getElementById('settings-modal').classList.add('hidden');
        document.getElementById('modal-overlay').classList.add('hidden');
        
        // Reload page to reflect new state properly without complex DOM rerendering
        setTimeout(() => location.reload(), 500);
    }
});

// Init
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').catch(err => {
            console.error('ServiceWorker registration failed: ', err);
        });

        // Reload once when a new service worker takes control, so a shipped fix
        // actually reaches the player instead of waiting behind a cache-first
        // index.html. The `refreshing` latch prevents a reload loop.
        let refreshing = false;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
            if (refreshing) return;
            refreshing = true;

            // Don't interrupt a game in progress; the next load will pick it up.
            if (gameState === 'playing' && guesses.length > 0) return;

            window.location.reload();
        });
    });
}

window.addEventListener('online', () => {
    showToast('You are back online. Syncing...');
    // A game blocked on the word list was waiting for exactly this; retry the
    // full start rather than just syncing.
    if (gameState === 'playing' && !targetWordResolved) {
        startGame().catch(e => console.warn('Retry failed:', e));
    } else {
        syncResults();
    }
});
window.addEventListener('offline', () => {
    showToast('You are offline. Playing in offline mode.');
});

function showWordLoadError() {
    document.getElementById('board').classList.add('hidden');
    document.getElementById('word-load-error').classList.remove('hidden');
}

function hideWordLoadError() {
    document.getElementById('board').classList.remove('hidden');
    document.getElementById('word-load-error').classList.add('hidden');
}

// Fetch the word list, resolve today's word, and start the game — or refuse
// to. A game dealt against the offline fallback word records a win or loss the
// real answer contradicts; it syncs, lands on the leaderboard as a grid that
// never turns green, and cannot be repaired from the client afterwards. So an
// unresolved word shows a retry panel instead of a board. Re-run by the retry
// button and the 'online' listener, so everything here must be safe to repeat.
async function startGame() {
    await fetchOfflineWords();
    determineTargetWord();
    // Not in the plaintext tier — maybe the sealed one covers it.
    if (!targetWordResolved) await resolveSealedWord();

    if (gameState === 'playing' && !targetWordResolved) {
        showWordLoadError();
        // Results from earlier games can still sync while we wait for a word.
        if (navigator.onLine) {
            syncResults().catch(e => console.warn('Background sync failed:', e));
        }
        return;
    }

    hideWordLoadError();
    // If this resolves the game it calls finishGame(), which already
    // schedules the post-game modal — don't schedule a second one below.
    const justResolved = resolveInterruptedGame();
    renderBoard();

    // Sync results and then pull down state (now that gameId is known)
    if (navigator.onLine) {
        syncResults().then(() => syncDown()).catch(e => console.warn('Background sync failed:', e));
    }

    if (gameState !== 'playing') {
        updateHeaderIconToStats();
        if (!justResolved) setTimeout(handlePostGame, 500);
    } else if (guesses.length === 0) {
        setTimeout(() => {
            document.getElementById('help-modal').classList.remove('hidden');
            document.getElementById('modal-overlay').classList.remove('hidden');
            animateBouncyWord('help-word-container');
        }, 100);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    initKeyboard();
    loadState();

    const retryBtn = document.getElementById('word-load-retry');
    if (retryBtn) {
        retryBtn.addEventListener('click', () => {
            startGame().catch(e => console.warn('Retry failed:', e));
        });
    }

    startGame().catch(e => console.warn('Initialization error:', e));
    registerWordRefresh();
});

// === ADMIN DASHBOARD LOGIC ===
let dashboardCurrentDate = new Date();
let dashboardSelectedDateStr = null;
let dashboardOriginalAmWord = '';
let dashboardOriginalPmWord = '';

async function attemptAdminLogin(user, pass) {
    if (!navigator.onLine) {
        showToast('Admin features are unavailable while offline');
        return;
    }
    try {
        const res = await fetch('/api/dashboard/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: user, password: pass })
        });
        
        if (res.ok) {
            enterDashboard();
        } else {
            const data = await res.json();
            showToast(data.error || 'Login failed');
        }
    } catch (e) {
        showToast('Server error during login');
    }
}

document.getElementById('admin-login-submit-btn').addEventListener('click', () => {
    const user = document.getElementById('admin-username-input').value;
    const pass = document.getElementById('admin-password-input').value;
    attemptAdminLogin(user, pass);
});

document.getElementById('admin-logout-btn').addEventListener('click', async () => {
    safeStorage.removeItem('hasAdminSession');
    safeStorage.removeItem('isAdmin');
    document.getElementById('admin-username-input').value = '';
    document.getElementById('admin-password-input').value = '';
    document.getElementById('admin-dashboard-modal').classList.add('hidden');
    document.getElementById('modal-overlay').classList.add('hidden');
    const adminBtn = document.getElementById('admin-btn-header');
    if (adminBtn) adminBtn.style.display = 'none';

    // The session cookie is HttpOnly, so clearing localStorage alone only hid
    // the UI — the token stayed valid server-side for its full week.
    try {
        await fetch('/api/dashboard/logout', { method: 'POST' });
    } catch (e) {
        console.warn('Could not clear the admin session on the server', e);
    }
});

document.getElementById('close-admin-dashboard-btn').addEventListener('click', () => {
    document.getElementById('admin-dashboard-modal').classList.add('hidden');
    document.getElementById('modal-overlay').classList.add('hidden');
});

// === ADMIN PASSKEYS (WebAuthn) ===
//
// Both ceremonies deliberately send the server the *unwrapped* results rather
// than the attestationObject: getPublicKey() gives SPKI the server can import
// directly, getPublicKeyAlgorithm() gives the COSE algorithm number, and
// getAuthenticatorData() gives the raw authData so the server can still check
// the rpIdHash and the flags itself. See the long comment at the top of
// lib/webauthn.js for why parsing the attestation object instead would buy
// nothing at attestation: "none".

function bufferToBase64url(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlToBuffer(value) {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/')
        .padEnd(value.length + ((4 - (value.length % 4)) % 4), '=');
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
}

function passkeysSupported() {
    return typeof window.PublicKeyCredential === 'function' &&
        !!(navigator.credentials && navigator.credentials.create && navigator.credentials.get);
}

// A cancelled or timed-out ceremony throws NotAllowedError, and the browser
// deliberately refuses to say which — distinguishing "user dismissed the sheet"
// from "nothing responded in 60s" would itself leak. So it is neither an error
// nor a success: say nothing at all.
//
// Reporting it as a failure is exactly how a perfectly working passkey setup
// comes to look broken: you tap the wrong thing, dismiss the sheet, and the app
// tells you your passkey failed.
function isCeremonyCancellation(e) {
    return e && (e.name === 'NotAllowedError' || e.name === 'AbortError');
}

async function signInWithPasskey() {
    if (!navigator.onLine) {
        showToast('Admin features are unavailable while offline');
        return;
    }

    try {
        const optionsRes = await fetch('/api/dashboard/passkeys/signin-options', { method: 'POST' });
        if (!optionsRes.ok) {
            showToast('Could not start passkey sign-in');
            return;
        }
        const options = await optionsRes.json();

        const assertion = await navigator.credentials.get({
            publicKey: {
                challenge: base64urlToBuffer(options.challenge),
                rpId: options.rpId,
                // Empty: the credential knows which account it belongs to, so
                // the browser's own picker answers "who" and there is no
                // username box to fill in.
                allowCredentials: [],
                userVerification: options.userVerification,
                timeout: options.timeout
            }
        });

        if (!assertion) return; // Treated as a cancellation.

        const verifyRes = await fetch('/api/dashboard/passkeys/signin-verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                challenge: options.challenge,
                credentialId: assertion.id,
                clientDataJSON: bufferToBase64url(assertion.response.clientDataJSON),
                authenticatorData: bufferToBase64url(assertion.response.authenticatorData),
                signature: bufferToBase64url(assertion.response.signature)
            })
        });

        if (verifyRes.ok) {
            enterDashboard();
        } else {
            const data = await verifyRes.json().catch(() => ({}));
            showToast(data.error || 'Could not sign in with that passkey');
        }
    } catch (e) {
        if (isCeremonyCancellation(e)) return;
        console.warn('Passkey sign-in failed', e);
        showToast('Could not sign in with that passkey');
    }
}

async function addPasskey() {
    const nicknameInput = document.getElementById('admin-passkey-nickname');
    const nickname = nicknameInput.value.trim();

    if (!nickname) {
        showToast('Give this passkey a name first');
        return;
    }

    try {
        const optionsRes = await fetch('/api/dashboard/passkeys/register-options', { method: 'POST' });
        if (!optionsRes.ok) {
            showToast('Could not start passkey registration');
            return;
        }
        const options = await optionsRes.json();

        const credential = await navigator.credentials.create({
            publicKey: {
                challenge: base64urlToBuffer(options.challenge),
                rp: options.rp,
                user: {
                    id: base64urlToBuffer(options.user.id),
                    name: options.user.name,
                    displayName: options.user.displayName
                },
                pubKeyCredParams: options.pubKeyCredParams,
                authenticatorSelection: options.authenticatorSelection,
                attestation: options.attestation,
                excludeCredentials: (options.excludeCredentials || []).map(c => ({
                    type: c.type,
                    id: base64urlToBuffer(c.id),
                    transports: c.transports
                })),
                timeout: options.timeout
            }
        });

        if (!credential) return;

        const response = credential.response;

        // These three are what make the server's CBOR decoder unnecessary. They
        // have been in every major browser for years, but check rather than
        // assume: without the guard, an old browser throws
        // "response.getPublicKey is not a function", which the catch below
        // would surface to the user as though they had done something wrong.
        if (typeof response.getPublicKey !== 'function' ||
            typeof response.getPublicKeyAlgorithm !== 'function' ||
            typeof response.getAuthenticatorData !== 'function') {
            showToast('This browser is too old to register a passkey');
            return;
        }

        const publicKey = response.getPublicKey();
        if (!publicKey) {
            showToast('This device produced a key we cannot use');
            return;
        }

        const verifyRes = await fetch('/api/dashboard/passkeys/register-verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                challenge: options.challenge,
                nickname,
                credentialId: credential.id,
                clientDataJSON: bufferToBase64url(response.clientDataJSON),
                authenticatorData: bufferToBase64url(response.getAuthenticatorData()),
                publicKey: bufferToBase64url(publicKey),
                algorithm: response.getPublicKeyAlgorithm(),
                transports: typeof response.getTransports === 'function' ? response.getTransports() : null
            })
        });

        const data = await verifyRes.json().catch(() => ({}));

        if (verifyRes.ok) {
            nicknameInput.value = '';
            showToast('Passkey added');
            loadPasskeys();
        } else {
            showToast(data.error || 'Could not register the passkey');
        }
    } catch (e) {
        if (isCeremonyCancellation(e)) return;

        // InvalidStateError is the authenticator honouring excludeCredentials:
        // this device is already enrolled. That is a normal thing to run into,
        // not a fault.
        if (e && e.name === 'InvalidStateError') {
            showToast('This device already has a passkey for this account');
            return;
        }
        console.warn('Passkey registration failed', e);
        showToast('Could not register the passkey');
    }
}

async function loadPasskeys() {
    const list = document.getElementById('admin-passkey-list');
    if (!list) return;

    try {
        const res = await fetch('/api/dashboard/passkeys');
        if (!res.ok) {
            list.textContent = 'Could not load passkeys.';
            return;
        }

        const data = await res.json();
        list.replaceChildren();

        if (!data.passkeys || data.passkeys.length === 0) {
            const empty = document.createElement('div');
            empty.style.opacity = '0.7';
            empty.textContent = 'No passkeys yet. Add one to sign in without a password.';
            list.appendChild(empty);
            return;
        }

        data.passkeys.forEach(passkey => {
            const row = document.createElement('div');
            row.style.cssText = 'display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 6px 0;';

            const label = document.createElement('span');
            // textContent, not innerHTML — the nickname is user-supplied, and
            // the admin leaderboard already taught this codebase that lesson.
            label.textContent = passkey.lastUsedAt
                ? `${passkey.nickname} — last used ${passkey.lastUsedAt.slice(0, 10)}`
                : `${passkey.nickname} — never used`;

            const remove = document.createElement('button');
            remove.textContent = 'Remove';
            remove.style.cssText = 'background: transparent; border: 1px solid #999; color: inherit; border-radius: 4px; padding: 4px 10px; cursor: pointer;';
            remove.addEventListener('click', () => removePasskey(passkey.id, passkey.nickname));

            row.appendChild(label);
            row.appendChild(remove);
            list.appendChild(row);
        });
    } catch (e) {
        console.warn('Could not load passkeys', e);
        list.textContent = 'Could not load passkeys.';
    }
}

async function removePasskey(id, nickname) {
    if (!confirm(`Remove the passkey "${nickname}"?`)) return;

    try {
        const res = await fetch(`/api/dashboard/passkeys/${encodeURIComponent(id)}`, { method: 'DELETE' });
        if (res.ok) {
            showToast('Passkey removed');
            loadPasskeys();
        } else {
            showToast('Could not remove the passkey');
        }
    } catch (e) {
        console.warn('Could not remove passkey', e);
        showToast('Could not remove the passkey');
    }
}

// Shared by both sign-in routes so the password path and the passkey path can
// never drift into opening the dashboard differently.
// Everything the dashboard needs loaded whenever it opens — whichever door it
// opens through. There are two: a fresh login (enterDashboard) and the header
// button with a session already live. The header path used to inline its own
// subset and silently miss anything added only to enterDashboard, which is
// how the runway indicator shipped invisible to a signed-in admin.
function openDashboard() {
    document.getElementById('admin-dashboard-modal').classList.remove('hidden');
    animateBouncyWord('dashboard-word-container', 'DASHBOARD');
    renderAdminCalendar();
    loadRunway();

    if (passkeysSupported()) {
        document.getElementById('admin-passkeys-section').style.display = 'block';
        loadPasskeys();
    }
}

function enterDashboard() {
    safeStorage.setItem('hasAdminSession', 'true');
    document.getElementById('admin-login-modal').classList.add('hidden');
    openDashboard();
}

// The scheduling runway line at the top of the dashboard. Words used to run
// out silently; now the auto-top-up (lib/runway.js) holds the 40-day floor
// and this line is where its health — and the pool it draws from — is seen.
async function loadRunway() {
    const el = document.getElementById('runway-indicator');
    if (!el) return;
    el.textContent = '';

    try {
        const res = await fetch('/api/dashboard/runway');
        if (!res.ok) return;
        const r = await res.json();

        const okColor = 'var(--correct-color, #2e7d32)';
        const warn = r.days < 14 ? '#d32f2f' : (r.days < r.targetDays ? '#e6a817' : okColor);
        const through = r.scheduledThrough ? r.scheduledThrough.replace(/-(AM|PM)$/, ' $1') : 'nothing scheduled';

        el.innerHTML = '';
        const line = document.createElement('div');
        line.style.color = warn;
        line.style.fontWeight = r.days < r.targetDays ? 'bold' : 'normal';
        line.textContent = `Words scheduled: ${r.days} days (through ${through})`;
        const pool = document.createElement('div');
        pool.style.fontSize = '0.85em';
        pool.style.opacity = '0.8';
        pool.textContent = `${r.poolAvailable} words left in the auto-top-up pool`;
        if (r.poolAvailable < 100) {
            pool.style.color = '#d32f2f';
            pool.textContent += ' — refill with regenerate-words.py --emit-pool';
        }
        el.appendChild(line);
        el.appendChild(pool);
    } catch (e) {
        // The indicator is advisory; a failed load just leaves it blank.
    }
}

if (passkeysSupported()) {
    // Revealed only where the browser can actually run the ceremony. A button
    // that opens nothing is worse than no button.
    document.getElementById('admin-passkey-row').style.display = 'block';
    document.getElementById('admin-passkey-signin-btn')
        .addEventListener('click', signInWithPasskey);
    document.getElementById('admin-add-passkey-btn')
        .addEventListener('click', addPasskey);
}

function renderAdminCalendar() {
    const year = dashboardCurrentDate.getFullYear();
    const month = dashboardCurrentDate.getMonth();
    
    const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    document.getElementById('month-display').textContent = `${monthNames[month]} ${year}`;
    
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    
    const grid = document.getElementById('calendar');
    
    // Clear existing days but keep the day names which we will generate
    grid.innerHTML = `
        <div class="day-name">Sun</div><div class="day-name">Mon</div><div class="day-name">Tue</div>
        <div class="day-name">Wed</div><div class="day-name">Thu</div><div class="day-name">Fri</div><div class="day-name">Sat</div>
    `;
    
    // Add empties
    for (let i = 0; i < firstDay; i++) {
        const empty = document.createElement('div');
        empty.className = 'day empty';
        grid.appendChild(empty);
    }
    
    // Add days
    for (let i = 1; i <= daysInMonth; i++) {
        const day = document.createElement('div');
        day.className = 'day';
        day.textContent = i;
        
        const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(i).padStart(2, '0')}`;
        day.dataset.date = dateStr;
        
        if (dateStr === dashboardSelectedDateStr) {
            day.classList.add('selected');
        }
        
        day.addEventListener('click', () => selectAdminDate(dateStr, day));
        grid.appendChild(day);
    }
    
    // Select today by default if no date is selected
    if (!dashboardSelectedDateStr) {
        const today = new Date();
        const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
        const todayEl = Array.from(grid.querySelectorAll('.day')).find(d => d.dataset.date === todayStr);
        if (todayEl) {
            selectAdminDate(todayStr, todayEl);
        }
    }
}

document.getElementById('prev-month').addEventListener('click', () => {
    dashboardCurrentDate.setMonth(dashboardCurrentDate.getMonth() - 1);
    renderAdminCalendar();
});

document.getElementById('next-month').addEventListener('click', () => {
    dashboardCurrentDate.setMonth(dashboardCurrentDate.getMonth() + 1);
    renderAdminCalendar();
});

async function selectAdminDate(dateStr, element) {
    document.querySelectorAll('.day.selected').forEach(e => e.classList.remove('selected'));
    if(element) element.classList.add('selected');
    dashboardSelectedDateStr = dateStr;
    
    // Start with the graph side first
    document.getElementById('am-flip-card').setAttribute('data-state', '1');
    document.getElementById('pm-flip-card').setAttribute('data-state', '1');
    
    document.getElementById('editor').style.display = 'block';
    document.getElementById('selected-date-display').textContent = `Words for ${dateStr}`;
    document.getElementById('am-word').value = '';
    document.getElementById('pm-word').value = '';
    
    const amPuzzleNum = getPuzzleNumber(`${dateStr}-AM`);
    const pmPuzzleNum = getPuzzleNumber(`${dateStr}-PM`);
    document.getElementById('am-label').textContent = amPuzzleNum === null ? 'AM Word' : `AM Word - #${amPuzzleNum}`;
    document.getElementById('pm-label').textContent = pmPuzzleNum === null ? 'PM Word' : `PM Word - #${pmPuzzleNum}`;
    
    // Fetch words for this date
    try {
        const res = await fetch(`/api/dashboard/words?date=${dateStr}`);
        if (res.ok) {
            const data = await res.json();
            if (data.AM) {
                const amWord = typeof data.AM === 'object' ? data.AM.word : data.AM;
                const amCount = typeof data.AM === 'object' ? data.AM.count : 0;
                dashboardOriginalAmWord = (amWord || '').toUpperCase();
                document.getElementById('am-word').value = amWord || '';
                document.getElementById('am-players').textContent = `Players: ${amCount}`;
            } else {
                dashboardOriginalAmWord = '';
                document.getElementById('am-word').value = '';
                document.getElementById('am-players').textContent = `Players: 0`;
            }
            if (data.PM) {
                const pmWord = typeof data.PM === 'object' ? data.PM.word : data.PM;
                const pmCount = typeof data.PM === 'object' ? data.PM.count : 0;
                dashboardOriginalPmWord = (pmWord || '').toUpperCase();
                document.getElementById('pm-word').value = pmWord || '';
                document.getElementById('pm-players').textContent = `Players: ${pmCount}`;
            } else {
                dashboardOriginalPmWord = '';
                document.getElementById('pm-word').value = '';
                document.getElementById('pm-players').textContent = `Players: 0`;
            }
        } else if (res.status === 401) {
            showToast('Session expired. Please log in again.');
            document.getElementById('admin-logout-btn').click();
        }
        
        loadAdminCardStats('AM');
        loadAdminCardStats('PM');
    } catch (e) {
        console.error('Failed to fetch words', e);
    }
    
    validateSaveButton();
}

function validateSaveButton() {
    const amWord = document.getElementById('am-word').value.trim().toUpperCase();
    const pmWord = document.getElementById('pm-word').value.trim().toUpperCase();
    const saveBtn = document.getElementById('save-words-btn');
    
    const isModified = (amWord !== dashboardOriginalAmWord) || (pmWord !== dashboardOriginalPmWord);
    
    if (!isModified) {
        saveBtn.style.display = 'none';
        return;
    }
    
    saveBtn.style.display = 'block';
    
    if ((amWord && amWord.length < 6) || (pmWord && pmWord.length < 6)) {
        saveBtn.disabled = true;
        saveBtn.style.opacity = '0.5';
        saveBtn.style.cursor = 'not-allowed';
    } else {
        saveBtn.disabled = false;
        saveBtn.style.opacity = '1';
        saveBtn.style.cursor = 'pointer';
    }
}

document.getElementById('am-word').addEventListener('input', validateSaveButton);
document.getElementById('pm-word').addEventListener('input', validateSaveButton);

document.getElementById('save-words-btn').addEventListener('click', async () => {
    const amWord = document.getElementById('am-word').value.trim().toUpperCase();
    const pmWord = document.getElementById('pm-word').value.trim().toUpperCase();

    if (!navigator.onLine) {
        showToast('Admin features are unavailable while offline');
        return;
    }

    // Only send the halves that actually changed. Posting both unconditionally
    // meant editing just the PM word would also submit an empty AM field —
    // which the server treats as "delete".
    const amChanged = amWord !== dashboardOriginalAmWord;
    const pmChanged = pmWord !== dashboardOriginalPmWord;

    // Validate only what's being saved. Validating both halves would make an
    // already-stored word that isn't in the dictionary block edits to the
    // other half of that date forever.
    const changedWords = [amChanged ? amWord : '', pmChanged ? pmWord : ''].filter(Boolean);

    if (changedWords.some(w => w.length !== 6)) {
        showToast('Words must be exactly 6 letters');
        return;
    }

    // A word outside the dictionary makes the puzzle unwinnable — the player's
    // guess is rejected as "Not in word list", so the answer can never be typed.
    const invalid = changedWords.find(w => !VALID_WORDS.has(w.toLowerCase()));
    if (invalid) {
        showToast(`'${invalid}' is not in the word list`);
        return;
    }

    try {

        let amRes = { ok: true };
        if (amChanged) {
            amRes = await fetch('/api/dashboard/words', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ date: dashboardSelectedDateStr, type: 'AM', word: amWord })
            });
        }

        let pmRes = { ok: true };
        if (pmChanged && amRes.ok) {
            pmRes = await fetch('/api/dashboard/words', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ date: dashboardSelectedDateStr, type: 'PM', word: pmWord })
            });
        }

        if (!amRes.ok) {
            if (amRes.status === 401) {
                showToast('Session expired. Please log in again.');
                document.getElementById('admin-logout-btn').click();
                return;
            }
            const err = await amRes.json();
            showToast(err.error || 'Failed to save AM word');
            return;
        }
        if (!pmRes.ok) {
            if (pmRes.status === 401) {
                showToast('Session expired. Please log in again.');
                document.getElementById('admin-logout-btn').click();
                return;
            }
            const err = await pmRes.json();
            showToast(err.error || 'Failed to save PM word');
            return;
        }
        
        dashboardOriginalAmWord = amWord.toUpperCase();
        dashboardOriginalPmWord = pmWord.toUpperCase();
        document.getElementById('save-words-btn').style.display = 'none';
        
        showToast('Words saved successfully!');
    } catch (e) {
        showToast('Network error while saving');
    }
});

// Flip card logic
document.getElementById('am-flip-card').addEventListener('dblclick', () => toggleAdminCard('am-flip-card', 'AM'));
document.getElementById('pm-flip-card').addEventListener('dblclick', () => toggleAdminCard('pm-flip-card', 'PM'));

function addSwipeToFlip(cardId, type) {
    const el = document.getElementById(cardId);
    let startX = 0;
    let isDown = false;
    
    el.addEventListener('pointerdown', (e) => {
        if (e.target.tagName.toLowerCase() === 'input' || e.target.tagName.toLowerCase() === 'span') return;
        isDown = true;
        startX = e.clientX;
        try { el.setPointerCapture(e.pointerId); } catch(err){}
    });
    
    el.addEventListener('pointerup', (e) => {
        if (!isDown) return;
        isDown = false;
        try { el.releasePointerCapture(e.pointerId); } catch(err){}
        const deltaX = e.clientX - startX;
        if (Math.abs(deltaX) > 40) {
            const dir = deltaX < 0 ? 1 : -1;
            toggleAdminCard(cardId, type, dir);
        }
    });
}
addSwipeToFlip('am-flip-card', 'AM');
addSwipeToFlip('pm-flip-card', 'PM');

document.querySelectorAll('.flip-arrow').forEach(arrow => {
    arrow.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        e.preventDefault();
        const cardId = arrow.getAttribute('data-card');
        const type = arrow.getAttribute('data-type');
        toggleAdminCard(cardId, type);
    });
});

async function toggleAdminCard(cardId, type, dir = 1) {
    const card = document.getElementById(cardId);
    let state = parseInt(card.getAttribute('data-state') || '0');
    state = (state + dir + 3) % 3;
    card.setAttribute('data-state', state);
    
    if (state === 1 && dashboardSelectedDateStr) {
        await loadAdminCardStats(type);
    } else if (state === 2 && dashboardSelectedDateStr) {
        await loadAdminLeaderboard(type);
    }
}

async function loadAdminCardStats(type) {
    if (!dashboardSelectedDateStr) return;
    const gameId = `${dashboardSelectedDateStr}-${type}`;
    const barsContainer = document.getElementById(`${type.toLowerCase()}-bars-container`);
    const statsText = document.getElementById(`${type.toLowerCase()}-stats-text`);
    const wordInput = document.getElementById(`${type.toLowerCase()}-word`).value.trim().toUpperCase();
    
    statsText.textContent = 'Loading...';
    buildGraph(Array(11).fill(0), barsContainer, statsText, null, 0, true, wordInput);
    
    try {
        const res = await fetch(`/api/game_stats?game_id=${gameId}`);
        if (res.ok) {
            const data = await res.json();
            buildGraph(data.distribution || Array(11).fill(0), barsContainer, statsText, null, 0, true, wordInput);
        } else {
            buildGraph(Array(11).fill(0), barsContainer, statsText, null, 0, true, wordInput);
        }
    } catch (e) {
        buildGraph(Array(11).fill(0), barsContainer, statsText, null, 0, true, wordInput);
    }
}

function formatTimeMs(ms) {
    if (!ms || ms <= 0) return '--:--';
    let totalSeconds = Math.floor(ms / 1000);
    if (totalSeconds === 0 && ms > 0) totalSeconds = 1;
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

async function loadAdminLeaderboard(type) {
    if (!dashboardSelectedDateStr) return;
    const gameId = `${dashboardSelectedDateStr}-${type}`;
    const container = document.getElementById(`${type.toLowerCase()}-leaderboard`);
    
    container.innerHTML = '<div style="text-align: center; color: var(--text-color); margin-top: 20px;">Loading...</div>';
    
    if (!navigator.onLine) {
        container.innerHTML = '<div style="text-align: center; color: var(--text-color); margin-top: 20px;">Leaderboard is unavailable while offline.</div>';
        return;
    }
    
    try {
        const res = await fetch(`/api/dashboard/leaderboard?game_id=${gameId}`);
        if (res.ok) {
            const data = await res.json();
            if (!data.leaderboard || data.leaderboard.length === 0) {
                container.innerHTML = '<div style="text-align: center; color: var(--text-color); margin-top: 20px;">No solves yet.</div>';
                return;
            }
            
            // display_name is player-controlled. Build these as text nodes —
            // interpolating into innerHTML made any player able to run script
            // inside the authenticated admin's session.
            container.innerHTML = '';
            data.leaderboard.forEach((entry, index) => {
                const row = document.createElement('div');
                row.className = 'leaderboard-row';

                const nameDiv = document.createElement('div');
                nameDiv.className = 'leaderboard-name';
                nameDiv.textContent = `${index + 1}. ${entry.display_name || 'Anonymous'}`;

                const statsDiv = document.createElement('div');
                statsDiv.className = 'leaderboard-stats';
                statsDiv.textContent = `${entry.guesses_taken} guess${entry.guesses_taken !== 1 ? 'es' : ''} | ${formatTimeMs(entry.time_taken_ms)}`;

                row.appendChild(nameDiv);
                row.appendChild(statsDiv);
                container.appendChild(row);
            });
        } else {
            container.innerHTML = '<div style="text-align: center; color: var(--text-color); margin-top: 20px;">Failed to load.</div>';
        }
    } catch (e) {
        container.innerHTML = '<div style="text-align: center; color: var(--text-color); margin-top: 20px;">Error loading.</div>';
    }
}

function handlePostGame() {
    const currentDisplayName = safeStorage.getItem('6lets_display_name') || '';
    if (currentDisplayName === '') {
        document.getElementById('name-prompt-modal').classList.remove('hidden');
        document.getElementById('modal-overlay').classList.remove('hidden');
        animateBouncyWord('prompt-word-container', 'AWESOME');
    } else {
        showStatsModal();
    }
}

document.getElementById('close-name-prompt-btn').addEventListener('click', () => {
    document.getElementById('name-prompt-modal').classList.add('hidden');
    showStatsModal();
});

document.getElementById('prompt-skip-btn').addEventListener('click', () => {
    document.getElementById('name-prompt-modal').classList.add('hidden');
    showStatsModal();
});

document.getElementById('prompt-save-name-btn').addEventListener('click', async () => {
    const nameInput = document.getElementById('prompt-display-name-input');
    const val = nameInput.value.trim();
    if (val === '') {
        document.getElementById('name-prompt-modal').classList.add('hidden');
        showStatsModal();
        return;
    }
    
    const saveBtn = document.getElementById('prompt-save-name-btn');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';
    
    try {
        const res = await fetch('/api/user', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ uuid: getUserUUID(), display_name: val })
        });
        
        if (res.ok) {
            safeStorage.setItem('6lets_display_name', val);
            const dnInput = document.getElementById('display-name-input');
            if (dnInput) dnInput.value = val;
            const updateDnBtn = document.getElementById('update-display-name-btn');
            if (updateDnBtn) updateDnBtn.style.display = 'none';
        } else {
            const data = await res.json().catch(() => ({}));
            showToast(data.error || 'Failed to save name');
        }
    } catch (e) {
        showToast('Error saving name');
    }
    
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save';
    
    document.getElementById('name-prompt-modal').classList.add('hidden');
    showStatsModal();
});

let newGamePromptShown = false;

function checkForNewGame() {
    if (gameState === 'won' || gameState === 'lost') {
        const currentActiveGameId = getGameId();
        if (currentActiveGameId !== gameId && !newGamePromptShown) {
            // Don't yank the settings or admin dashboard out from under someone
            // mid-edit — only close the game-flow modals.
            hidePlayerGrid();
            ['stats-modal', 'history-modal', 'help-modal', 'name-prompt-modal']
                .forEach(id => document.getElementById(id).classList.add('hidden'));

            document.getElementById('new-game-modal').classList.remove('hidden');
            document.getElementById('modal-overlay').classList.remove('hidden');
            animateBouncyWord('new-game-word-container', 'NEW GAME!');
            newGamePromptShown = true;
        }
    }
}

setInterval(checkForNewGame, 10000);

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        checkForNewGame();
    }
});

document.getElementById('close-new-game-btn').addEventListener('click', () => {
    document.getElementById('new-game-modal').classList.add('hidden');
    document.getElementById('modal-overlay').classList.add('hidden');
});

document.getElementById('play-new-game-btn').addEventListener('click', () => {
    window.location.reload();
});

// Screen Wake Lock API
let wakeLock = null;

const requestWakeLock = async () => {
    if (!('wakeLock' in navigator)) return;
    if (wakeLock !== null && !wakeLock.released) return;

    try {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => {
            wakeLock = null;
        });
    } catch (err) {
        // Commonly rejects when the document isn't visible — not worth logging
        // as an error on every backgrounded load.
        wakeLock = null;
    }
};

// Retry whenever we become visible again, not only when a lock was previously
// held — the initial request fails if the page starts hidden, and the old
// `wakeLock !== null` guard meant it was then never retried.
document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible') {
        await requestWakeLock();
    }
});

// Request initial wake lock
requestWakeLock();
