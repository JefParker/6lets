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
let guesses = [];
let currentGuess = '';
let gameId = '';
let targetWord = 'SODIUM'; // Fallback offline word
let gameState = 'playing'; // playing, won, lost
let startTime = null;
let elapsedTimeMs = 0;
let offlineWords = [];

// Theme initialization
const savedTheme = safeStorage.getItem('6lets_theme') || 'original';
document.documentElement.setAttribute('data-theme', savedTheme);

// Determine Game ID and Date (LA Time)
function getGameId() {
    // Current time in Los Angeles
    const options = { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false };
    const formatter = new Intl.DateTimeFormat('en-US', options);
    const parts = formatter.formatToParts(new Date());
    
    let year, month, day, hour;
    for (const part of parts) {
        if (part.type === 'year') year = part.value;
        if (part.type === 'month') month = part.value;
        if (part.type === 'day') day = part.value;
        if (part.type === 'hour') hour = parseInt(part.value, 10);
    }
    
    const ampm = hour < 12 ? 'AM' : 'PM';
    return `${year}-${month}-${day}-${ampm}`;
}

// UUID generator
function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

function getUserUUID() {
    let uuid = safeStorage.getItem('6lets_uuid') || crypto.randomUUID();
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
        const eval = evaluateGuess(guess, targetWord);
        for (let i = 0; i < WORD_LENGTH; i++) {
            const char = guess[i];
            const state = eval[i];
            
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
    const eval = Array(WORD_LENGTH).fill('absent');
    const targetChars = target.split('');
    const guessChars = guess.split('');
    
    // First pass: correct
    for (let i = 0; i < WORD_LENGTH; i++) {
        if (guessChars[i] === targetChars[i]) {
            eval[i] = 'correct';
            targetChars[i] = null;
            guessChars[i] = null;
        }
    }
    
    // Second pass: present
    for (let i = 0; i < WORD_LENGTH; i++) {
        if (guessChars[i] !== null) {
            const index = targetChars.indexOf(guessChars[i]);
            if (index !== -1) {
                eval[i] = 'present';
                targetChars[index] = null;
            }
        }
    }
    
    return eval;
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
    guesses.push(currentGuess);
    const guessSubmitted = currentGuess;
    currentGuess = '';
    
    // Flip animations
    for (let i = 0; i < WORD_LENGTH; i++) {
        const tile = activeRow.children[i];
        setTimeout(() => {
            tile.classList.add('flip');
            // Change color halfway through flip
            setTimeout(() => {
                const eval = evaluateGuess(guessSubmitted, targetWord);
                tile.dataset.state = eval[i];
                if (i === WORD_LENGTH - 1) {
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

function getPuzzleNumber(gameIdStr) {
    if (!gameIdStr) return 3299;
    const [year, month, day, ampm] = gameIdStr.split('-');
    const puzzleDate = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
    const epochDate = new Date(2026, 6, 8); // July 8, 2026
    const diffDays = Math.round((puzzleDate - epochDate) / (1000 * 60 * 60 * 24));
    
    const offset = (diffDays * 2) + (ampm === 'AM' ? 0 : 1);
    return 3298 + offset; 
}

function autoRecoverStreak(rGames, currentStreak) {
    if (!rGames || rGames.length === 0) return currentStreak;
    
    const completedPuzzles = [];
    for (let i = 0; i < rGames.length; i++) {
        const game = rGames[i];
        if (game.includes("- X guesses")) continue;
        const match = game.match(/^#(\d+) /);
        if (match) {
            completedPuzzles.push(parseInt(match[1]));
        }
    }
    
    if (completedPuzzles.length === 0) return currentStreak;
    
    completedPuzzles.sort((a, b) => b - a);
    
    let calcStreak = 1;
    let expectedNext = completedPuzzles[0] - 1;
    
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
        const gameIdText = `#${puzzleNum}`;
        const resultText = `${guesses.length} guesses`;
        recentGames = recentGames.filter(game => !game.startsWith(`${gameIdText} `));
        recentGames.unshift(`${gameIdText} ${targetWord} - ${resultText}`);
        completedGames++;
        totalGuessesFinished += guesses.length;
        guessDistribution[guesses.length - 1]++;
        
        const winMessages = ['Genius!', 'Magnificent!', 'Impressive!', 'Splendid!', 'Great!', 'Phew!'];
        showToast(winMessages[guesses.length - 1] || 'Good job!');
        
        let currentStreak = parseInt(safeStorage.getItem('6lets_streak')) || 0;
        let lastCompletedPuzzle = parseInt(safeStorage.getItem('6lets_lastCompletedPuzzle')) || 0;
        
        if (puzzleNum === lastCompletedPuzzle + 1 || lastCompletedPuzzle === 0) {
            currentStreak++;
        } else if (puzzleNum > lastCompletedPuzzle + 1) {
            currentStreak = 1;
        }
        
        currentStreak = autoRecoverStreak(recentGames, currentStreak);
        
        if (currentStreak > completedGames) {
            currentStreak = completedGames;
        }
        
        safeStorage.setItem('6lets_streak', currentStreak);
        safeStorage.setItem('6lets_lastCompletedPuzzle', Math.max(lastCompletedPuzzle, puzzleNum));
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
        const gameIdText = `#${puzzleNum}`;
        recentGames = recentGames.filter(game => !game.startsWith(`${gameIdText} `));
        recentGames.unshift(`${gameIdText} ${targetWord} - X guesses`);
        if (recentGames.length > 10) recentGames.length = 10;
        unfinishedGames++;
        
        safeStorage.setItem('6lets_streak', 0);
        safeStorage.setItem('6lets_lastCompletedPuzzle', puzzleNum);
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
    
    // Queue offline sync
    let pending = JSON.parse(safeStorage.getItem('pending_sync') || '[]');
    pending.push(result);
    safeStorage.setItem('pending_sync', JSON.stringify(pending));
    
    syncResults(); // Try to sync immediately
    
    setTimeout(() => handlePostGame(), 1500);
}

function buildGraph(distributionData, container, textElement, highlightGameStatus = null, highlightGuessCount = 0, hideHighlight = false, wordLabel = "") {
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
        const total = chartData.reduce((a, b) => a + b, 0);
        const prefix = wordLabel ? `${wordLabel} - ` : '';
        if (total === 0) {
            textElement.textContent = `${prefix}0 Players`;
            return;
        }
        if (showTotal) {
            textElement.textContent = `${prefix}${total} Player${total !== 1 ? 's' : ''}`;
            return;
        }
        const pct = Math.round((chartData[index] / total) * 100);
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
    
    animateBouncyWord('stats-word-container', targetWord);
    
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
                            row.className = 'leaderboard-row';
                            
                            const nameDiv = document.createElement('div');
                            nameDiv.className = 'leaderboard-name';
                            nameDiv.textContent = entry.display_name || 'Anonymous';
                            
                            const statsDiv = document.createElement('div');
                            statsDiv.className = 'leaderboard-stats';
                            statsDiv.textContent = `${entry.guesses_taken} guess${entry.guesses_taken > 1 ? 'es' : ''} - ${formatTimeMs(entry.time_taken_ms)}`;
                            
                            row.appendChild(nameDiv);
                            row.appendChild(statsDiv);
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

document.querySelector('.close-btn').addEventListener('click', () => {
    document.getElementById('stats-modal').classList.add('hidden');
    document.getElementById('modal-overlay').classList.add('hidden');
});

const getShareText = () => {
    const options = { month: 'short', day: '2-digit', year: 'numeric' };
    const dateString = new Date().toLocaleDateString('en-US', options);
    
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
    
    const getPuzzleNumber = (gameIdStr) => {
        if (!gameIdStr) return 3299;
        const parts = gameIdStr.split('-');
        if (parts.length !== 4) return 3299;
        const [year, month, day, ampm] = parts;
        const puzzleDate = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
        const epochDate = new Date(2026, 6, 8); // July 8, 2026
        const diffDays = Math.round((puzzleDate - epochDate) / (1000 * 60 * 60 * 24));
        
        const offset = (diffDays * 2) + (ampm === 'AM' ? 0 : 1);
        return 3298 + offset; 
    };

    const puzzleNum = getPuzzleNumber(gameId);
    return `Six Letters\n${dateString} (#${puzzleNum})\n${emojiGrid}https://6lets.com/`;
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
    safeStorage.setItem('6lets_distribution', JSON.stringify(guessDistribution));
    safeStorage.setItem('6lets_completed', completedGames);
    safeStorage.setItem('6lets_unfinished', unfinishedGames);
    safeStorage.setItem('6lets_totalGuesses', totalGuessesFinished);
    safeStorage.setItem('6lets_recentGames', JSON.stringify(recentGames));
}

function loadState() {
    gameId = getGameId();
    
    const lastGameId = safeStorage.getItem('6lets_lastGameId');
    if (lastGameId && lastGameId !== gameId) {
        const lastStateStr = safeStorage.getItem(`gameState_${lastGameId}`);
        if (lastStateStr) {
            const lastState = JSON.parse(lastStateStr);
            if (lastState.gameState === 'playing' && lastState.guesses && lastState.guesses.length > 0) {
                unfinishedGames++;
                safeStorage.setItem('6lets_unfinished', unfinishedGames);
                lastState.gameState = 'lost';
                safeStorage.setItem(`gameState_${lastGameId}`, JSON.stringify(lastState));
            }
        }
    }
    safeStorage.setItem('6lets_lastGameId', gameId);

    const savedStateStr = safeStorage.getItem(`gameState_${gameId}`);
    if (savedStateStr) {
        const savedState = JSON.parse(savedStateStr);
        guesses = savedState.guesses || [];
        currentGuess = savedState.currentGuess || '';
        gameState = savedState.gameState || 'playing';
        startTime = savedState.startTime || null;
        elapsedTimeMs = savedState.elapsedTimeMs || 0;
    }
    
    // Check if missed a puzzle to break streak
    let currentStreak = parseInt(safeStorage.getItem('6lets_streak')) || 0;
    let lastCompletedPuzzle = parseInt(safeStorage.getItem('6lets_lastCompletedPuzzle')) || 0;
    const currentPuzzle = getPuzzleNumber(gameId);
    
    if (gameState === 'playing' && lastCompletedPuzzle > 0 && currentPuzzle > lastCompletedPuzzle + 1) {
        safeStorage.setItem('6lets_streak', 0);
        currentStreak = 0;
        
        if (recentGames.length > 10) {
            recentGames.length = 10;
            safeStorage.setItem('6lets_recentGames', JSON.stringify(recentGames));
        }
    }
    
    // Auto-recover streak from recent games if it was incorrectly lost
    const recentGamesStr = safeStorage.getItem('6lets_recentGames');
    if (recentGamesStr) {
        const rGames = JSON.parse(recentGamesStr);
        let calcStreak = autoRecoverStreak(rGames, 0);
        if (calcStreak > currentStreak) {
            currentStreak = calcStreak;
            safeStorage.setItem('6lets_streak', currentStreak);
        }
    }
    
    const historyBtnText = document.getElementById('history-btn-text');
    if (historyBtnText) historyBtnText.textContent = currentStreak;
}

// Pause timer when hiding page
document.addEventListener('visibilitychange', () => {
    if (gameState !== 'playing') return;
    
    if (document.visibilityState === 'hidden') {
        if (startTime !== null) {
            elapsedTimeMs += (Date.now() - startTime);
            startTime = null;
            saveState();
        }
    } else if (document.visibilityState === 'visible') {
        // We do not resume startTime here. We wait for next keystroke as per requirements.
    }
});

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

// Sync logic
async function syncResults() {
    if (!navigator.onLine) return;
    
    const pending = JSON.parse(safeStorage.getItem('pending_sync') || '[]');
    if (pending.length === 0) return;
    
    try {
        const response = await fetch('/api/results', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                pending,
                '6lets_distribution': JSON.stringify(guessDistribution),
                '6lets_completed': completedGames,
                '6lets_unfinished': unfinishedGames,
                '6lets_totalGuesses': totalGuessesFinished,
                '6lets_recentGames': JSON.stringify(recentGames)
            })
        });
        
        if (response.ok) {
            safeStorage.setItem('pending_sync', '[]');
        }
    } catch (e) {
        console.error('Failed to sync', e);
    }
}

async function fetchOfflineWords() {
    try {
        const response = await fetch('/api/words');
        if (response.ok) {
            const data = await response.json(); // Array of { id, word: base64 }
            safeStorage.setItem('offline_words', JSON.stringify(data));
        }
    } catch (e) {
        console.error('Failed to fetch offline words', e);
    }
}

function determineTargetWord() {
    const offline = JSON.parse(safeStorage.getItem('offline_words') || '[]');
    const match = offline.find(w => w.id === gameId);
    if (match) {
        targetWord = atob(match.word).toUpperCase();
    }
    // Fallback is 'SODIUM' defined at the top
}

// Sync Down logic
async function syncDown(force = false) {
    if (!navigator.onLine) return;
    try {
        const uuid = getUserUUID();
        const response = await fetch(`/api/user?uuid=${uuid}&game_id=${gameId}`);
        if (response.ok) {
            const stats = await response.json();
            
            guessDistribution = JSON.parse(stats['6lets_distribution'] || '[0,0,0,0,0,0,0,0,0,0]');
            completedGames = stats['6lets_completed'] || 0;
            unfinishedGames = stats['6lets_unfinished'] || 0;
            totalGuessesFinished = stats['6lets_totalGuesses'] || 0;
            recentGames = JSON.parse(stats['6lets_recentGames'] || '[]');
            
            safeStorage.setItem('6lets_distribution', JSON.stringify(guessDistribution));
            safeStorage.setItem('6lets_completed', completedGames);
            safeStorage.setItem('6lets_unfinished', unfinishedGames);
            safeStorage.setItem('6lets_totalGuesses', totalGuessesFinished);
            safeStorage.setItem('6lets_recentGames', JSON.stringify(recentGames));

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

            // Sync current game board state if completed in cloud
            if (stats.cloud_gameState && (gameState === 'playing' || force)) {
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
            document.getElementById('admin-dashboard-modal').classList.remove('hidden');
            document.getElementById('modal-overlay').classList.remove('hidden');
            animateBouncyWord('dashboard-word-container', 'DASHBOARD');
            renderAdminCalendar();
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
        
        if (res.ok) {
            safeStorage.setItem('6lets_display_name', val);
            updateDnBtn.textContent = 'Update';
            updateDnBtn.disabled = false;
            updateDnBtn.style.display = 'none';
            showToast('Display name updated');
        } else {
            updateDnBtn.textContent = 'Update';
            updateDnBtn.disabled = false;
            showToast('Failed to update name');
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
        
        // Wipe local game state to ensure we cleanly load the new UUID's state
        safeStorage.removeItem('6lets_gameState');
        safeStorage.removeItem('6lets_guesses');
        safeStorage.removeItem('6lets_elapsedTimeMs');
        gameState = 'playing';
        guesses = [];
        
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
        navigator.serviceWorker.register('/sw.js').then(reg => {
            reg.addEventListener('updatefound', () => {
                const newWorker = reg.installing;
                newWorker.addEventListener('statechange', () => {
                    if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                        // Let the user know it's updating or just force reload
                    }
                });
            });
        }).catch(err => {
            console.error('ServiceWorker registration failed: ', err);
        });
        
        let refreshing = false;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
            if (!refreshing) {
                refreshing = true;
                // Prevent infinite reload loops in dev mode
                // window.location.reload();
            }
        });
    });
}

window.addEventListener('online', () => {
    showToast('You are back online. Syncing...');
    syncResults();
});
window.addEventListener('offline', () => {
    showToast('You are offline. Playing in offline mode.');
});

document.addEventListener('DOMContentLoaded', () => {
    initKeyboard();
    loadState();
    
    fetchOfflineWords().then(() => {
        determineTargetWord();
        renderBoard();
        
        // Sync results and then pull down state (now that gameId is known)
        if (navigator.onLine) {

            
            syncResults().then(() => syncDown()).catch(e => console.warn('Background sync failed:', e));
        }

        if (gameState !== 'playing') {
            updateHeaderIconToStats();
            setTimeout(handlePostGame, 500);
        } else if (guesses.length === 0) {
            setTimeout(() => {
                document.getElementById('help-modal').classList.remove('hidden');
                document.getElementById('modal-overlay').classList.remove('hidden');
                animateBouncyWord('help-word-container');
            }, 100);
        }
    }).catch(e => console.warn('Initialization error:', e));
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
            safeStorage.setItem('hasAdminSession', 'true');
            document.getElementById('admin-login-modal').classList.add('hidden');
            document.getElementById('admin-dashboard-modal').classList.remove('hidden');
            animateBouncyWord('dashboard-word-container', 'DASHBOARD');
            renderAdminCalendar();
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

document.getElementById('admin-logout-btn').addEventListener('click', () => {
    safeStorage.removeItem('hasAdminSession');
    safeStorage.removeItem('isAdmin');
    document.getElementById('admin-username-input').value = '';
    document.getElementById('admin-password-input').value = '';
    document.getElementById('admin-dashboard-modal').classList.add('hidden');
    document.getElementById('modal-overlay').classList.add('hidden');
    const adminBtn = document.getElementById('admin-btn-header');
    if (adminBtn) adminBtn.style.display = 'none';
});

document.getElementById('close-admin-dashboard-btn').addEventListener('click', () => {
    document.getElementById('admin-dashboard-modal').classList.add('hidden');
    document.getElementById('modal-overlay').classList.add('hidden');
});

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
    
    function getPuzzleNumber(dStr, type) {
        const [y, m, d] = dStr.split('-');
        const puzzleDate = new Date(parseInt(y), parseInt(m) - 1, parseInt(d));
        const epochDate = new Date(2026, 6, 8);
        const diffDays = Math.round((puzzleDate - epochDate) / (1000 * 60 * 60 * 24));
        return 3298 + (diffDays * 2) + (type === 'AM' ? 0 : 1);
    }
    
    const amPuzzleNum = getPuzzleNumber(dateStr, 'AM');
    const pmPuzzleNum = getPuzzleNumber(dateStr, 'PM');
    document.getElementById('am-label').textContent = `AM Word - #${amPuzzleNum}`;
    document.getElementById('pm-label').textContent = `PM Word - #${pmPuzzleNum}`;
    
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
    const amWord = document.getElementById('am-word').value.trim();
    const pmWord = document.getElementById('pm-word').value.trim();
    
    if (!navigator.onLine) {
        showToast('Admin features are unavailable while offline');
        return;
    }
    
    if ((amWord && amWord.length !== 6) || (pmWord && pmWord.length !== 6)) {
        showToast('Words must be exactly 6 letters');
        return;
    }

    try {
        let amRes = { ok: true };
        if (amWord !== undefined) {
            amRes = await fetch('/api/dashboard/words', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ date: dashboardSelectedDateStr, type: 'AM', word: amWord })
            });
        }
        
        let pmRes = { ok: true };
        if (pmWord !== undefined && amRes.ok) {
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
            
            let html = '';
            data.leaderboard.forEach((entry, index) => {
                const name = entry.display_name || 'Anonymous';
                const timeStr = formatTimeMs(entry.time_taken_ms);
                html += `
                    <div class="leaderboard-row">
                        <div class="leaderboard-name">${index + 1}. ${name}</div>
                        <div class="leaderboard-stats">${entry.guesses_taken} guess${entry.guesses_taken !== 1 ? 'es' : ''} | ${timeStr}</div>
                    </div>
                `;
            });
            container.innerHTML = html;
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
            showToast('Failed to save name');
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
            // Hide other modals just in case
            document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
            
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
    try {
        if ('wakeLock' in navigator) {
            wakeLock = await navigator.wakeLock.request('screen');
            wakeLock.addEventListener('release', () => {
                console.log('Screen Wake Lock released:', wakeLock.released);
            });
            console.log('Screen Wake Lock acquired:', !wakeLock.released);
        }
    } catch (err) {
        console.error(`Wake Lock error: ${err.name}, ${err.message}`);
    }
};

document.addEventListener('visibilitychange', async () => {
    if (wakeLock !== null && document.visibilityState === 'visible') {
        await requestWakeLock();
    }
});

// Request initial wake lock
requestWakeLock();
