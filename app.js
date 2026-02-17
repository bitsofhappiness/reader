// Symphony PDF Audio Reader - Core Logic

// -- Database Helper (IndexedDB) --
class SymphonyDB {
    constructor() {
        this.dbName = 'SymphonyDB';
        this.dbVersion = 1;
        this.storeName = 'AppData';
        this.db = null;
    }

    async init() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.dbVersion);
            request.onerror = () => reject('Database failed to open');
            request.onsuccess = () => {
                this.db = request.result;
                resolve();
            };
            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(this.storeName)) {
                    db.createObjectStore(this.storeName);
                }
            };
        });
    }

    async set(key, value) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readwrite');
            const store = transaction.objectStore(this.storeName);
            const request = store.put(value, key);
            request.onsuccess = () => resolve();
            request.onerror = () => reject('Save failed');
        });
    }

    async get(key) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readonly');
            const store = transaction.objectStore(this.storeName);
            const request = store.get(key);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject('Load failed');
        });
    }

    async delete(key) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readwrite');
            const store = transaction.objectStore(this.storeName);
            const request = store.delete(key);
            request.onsuccess = () => resolve();
            request.onerror = () => reject('Delete failed');
        });
    }
}

const db = new SymphonyDB();

// Initialize PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// State Management
const state = {
    pdf: null,
    fileName: '',
    numPages: 0,
    fullText: '',
    chunks: [],
    unfilteredFullText: '', // Keep original for re-processing
    currentChunkIndex: 0,
    lastEnqueuedIndex: -1,
    bufferSize: 2,
    isPlaying: false,
    isPaused: false,
    catalog: [], // Array of document states
    currentDocID: null,
    settings: {
        voiceURI: null,
        voice: null,
        rate: 1.0,
        pitch: 1.0,
        volume: 1.0,
        fontSize: 1.2,
        chunkSize: 50,
        textAlign: 'justify',
        showText: true,
        skipPhrases: [] // Array of phrases to remove
    },
    voices: []
};

// DOM Elements
const elements = {
    dropzone: document.getElementById('dropzone'),
    fileInput: document.getElementById('fileInput'),
    playerControls: document.getElementById('playerControls'),
    sidebar: document.getElementById('sidebar'),
    sidebarToggle: document.getElementById('sidebarToggle'),
    fileName: document.getElementById('fileName'),
    fileStats: document.getElementById('fileStats'),
    progressBarFill: document.getElementById('progressBarFill'),
    progressPercent: document.getElementById('progressPercent'),
    wordProgress: document.getElementById('wordProgress'),
    playBtn: document.getElementById('playBtn'),
    playIcon: document.getElementById('playIcon'),
    pauseIcon: document.getElementById('pauseIcon'),
    prevBtn: document.getElementById('prevBtn'),
    nextBtn: document.getElementById('nextBtn'),
    fastPrevBtn: document.getElementById('fastPrevBtn'),
    fastNextBtn: document.getElementById('fastNextBtn'),
    sidebarSettingsBtn: document.getElementById('sidebarSettingsBtn'),
    settingsPanel: document.getElementById('settingsPanel'),
    closeSettings: document.getElementById('closeSettings'),
    voiceSelect: document.getElementById('voiceSelect'),
    rateRange: document.getElementById('rateRange'),
    pitchRange: document.getElementById('pitchRange'),
    volumeRange: document.getElementById('volumeRange'),
    rateVal: document.getElementById('rateVal'),
    pitchVal: document.getElementById('pitchVal'),
    volumeVal: document.getElementById('volumeVal'),
    fontSizeRange: document.getElementById('fontSizeRange'),
    fontSizeVal: document.getElementById('fontSizeVal'),
    alignBtns: document.querySelectorAll('.align-btn'),
    showTextToggle: document.getElementById('showTextToggle'),
    readingViewer: document.getElementById('readingViewer'),
    currentText: document.getElementById('currentText'),
    closeDocBtn: document.getElementById('closeDocBtn'),
    catalogList: document.getElementById('catalogList'),
    playbackBar: document.getElementById('playbackBar'),
    skipPhrasesInput: document.getElementById('skipPhrasesInput'),
    applySkipPhrases: document.getElementById('applySkipPhrases'),
    sidebarScrim: document.getElementById('sidebarScrim'),
    chunkSizeRange: document.getElementById('chunkSizeRange'),
    chunkSizeVal: document.getElementById('chunkSizeVal')
};

// --- Initialization ---

// Load voices for Web Speech API
function loadVoices() {
    state.voices = window.speechSynthesis.getVoices();
    elements.voiceSelect.innerHTML = state.voices
        .map((voice, index) => `<option value="${index}">${voice.name} (${voice.lang})</option>`)
        .join('');

    // Set default voice (prefer Google English or similar high quality)
    const defaultVoiceIndex = state.voices.findIndex(v => v.name.includes('Google') && v.lang.startsWith('en')) || 0;
    if (defaultVoiceIndex !== -1) {
        elements.voiceSelect.value = defaultVoiceIndex;
        state.settings.voice = state.voices[defaultVoiceIndex];
    }
}

// Initial load
window.speechSynthesis.onvoiceschanged = () => {
    loadVoices();
    applyPersistedVoice();
};

async function initApp() {
    loadVoices();
    await db.init();
    await loadState();
    applyPersistedVoice();
}

initApp();

function applyPersistedVoice() {
    if (state.settings.voiceURI && state.voices.length > 0) {
        const voice = state.voices.find(v => v.voiceURI === state.settings.voiceURI);
        if (voice) {
            state.settings.voice = voice;
            const index = state.voices.indexOf(voice);
            elements.voiceSelect.value = index;
        }
    }
}

// --- Event Listeners ---

// Upload Logic
elements.dropzone.addEventListener('click', () => elements.fileInput.click());
elements.dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    elements.dropzone.classList.add('active');
});
elements.dropzone.addEventListener('dragleave', () => elements.dropzone.classList.remove('active'));
elements.dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    elements.dropzone.classList.remove('active');
    const file = e.dataTransfer.files[0];
    if (file && file.type === 'application/pdf') {
        handleFileSelect(file);
    }
});

elements.fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) handleFileSelect(file);
});

// Control Logic
elements.sidebarToggle.addEventListener('click', toggleSidebar);
elements.sidebarScrim.addEventListener('click', closeSidebar);

function toggleSidebar() {
    const isCollapsed = elements.sidebar.classList.contains('collapsed');
    if (isCollapsed) {
        openSidebar();
    } else {
        closeSidebar();
    }
}

function openSidebar() {
    elements.sidebar.classList.remove('collapsed');
    if (window.innerWidth <= 768) {
        elements.sidebarScrim.classList.add('visible');
    }
}

function closeSidebar() {
    elements.sidebar.classList.add('collapsed');
    elements.sidebarScrim.classList.remove('visible');
}
elements.playBtn.addEventListener('click', togglePlayback);
elements.prevBtn.addEventListener('click', () => navigateChunk(-1));
elements.nextBtn.addEventListener('click', () => navigateChunk(1));
elements.fastPrevBtn.addEventListener('click', () => navigateChunk(-10));
elements.fastNextBtn.addEventListener('click', () => navigateChunk(10));
// closeDocBtn removed from reader header
const addNewDocHandler = async () => {
    if (state.currentDocID) await saveState();
    await stopPlayback();
    closeSidebar();
    showUploadZone();
};

// Global click delegation for dynamically added elements if needed, 
// but local attachment in updateCatalogUI is preferred.

// Settings Logic
elements.sidebarSettingsBtn.addEventListener('click', () => {
    elements.settingsPanel.classList.remove('hidden');
});
elements.closeSettings.addEventListener('click', () => elements.settingsPanel.classList.add('hidden'));

elements.voiceSelect.addEventListener('change', async (e) => {
    state.settings.voice = state.voices[e.target.value];
    state.settings.voiceURI = state.settings.voice.voiceURI;
    await saveState();
    if (state.isPlaying) {
        restartCurrentChunk();
    }
});

elements.rateRange.addEventListener('input', (e) => {
    state.settings.rate = parseFloat(e.target.value);
    elements.rateVal.textContent = state.settings.rate + 'x';
    if (state.isPlaying) {
        restartCurrentChunk();
    }
});

elements.pitchRange.addEventListener('input', (e) => {
    state.settings.pitch = parseFloat(e.target.value);
    elements.pitchVal.textContent = state.settings.pitch;
    if (state.isPlaying) {
        restartCurrentChunk();
    }
});

elements.volumeRange.addEventListener('input', (e) => {
    state.settings.volume = parseFloat(e.target.value);
    elements.volumeVal.textContent = Math.round(state.settings.volume * 100) + '%';
    if (state.isPlaying) {
        restartCurrentChunk();
    }
});

elements.showTextToggle.addEventListener('change', async (e) => {
    state.settings.showText = e.target.checked;
    await saveState();
    updateViewerVisibility();
});

elements.fontSizeRange.addEventListener('input', (e) => {
    state.settings.fontSize = parseFloat(e.target.value);
    elements.fontSizeVal.textContent = state.settings.fontSize + 'rem';
    elements.currentText.style.fontSize = state.settings.fontSize + 'rem';
    saveState();
});

elements.chunkSizeRange.addEventListener('input', (e) => {
    const val = parseInt(e.target.value);
    state.settings.chunkSize = val;
    elements.chunkSizeVal.textContent = val + ' words';
});

elements.chunkSizeRange.addEventListener('change', async () => {
    await saveState();
    if (state.currentDocID && state.unfilteredFullText) {
        await reProcessText();
    }
});

elements.alignBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        state.settings.textAlign = btn.dataset.align;
        applyAlignmentUI();
        saveState();
    });
});

elements.applySkipPhrases.addEventListener('click', async () => {
    const text = elements.skipPhrasesInput.value;
    state.settings.skipPhrases = text.split('\n').map(p => p.trim()).filter(p => p !== '');
    await saveState();

    if (state.currentDocID && state.unfilteredFullText) {
        await reProcessText();
    }
});

// --- Core Functions ---

async function handleFileSelect(file) {
    if (state.currentDocID) await saveState();

    state.fileName = file.name;
    state.currentDocID = Date.now().toString();

    try {
        const arrayBuffer = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
        state.pdf = pdf;
        state.numPages = pdf.numPages;
        await extractText();

        upsertCatalog();
        showPlayer();
        saveState();
    } catch (error) {
        console.error('Error loading PDF:', error);
        alert('Failed to load PDF. Please try another file.');
    }
}

function showPlayer() {
    elements.fileName.textContent = state.fileName;
    elements.dropzone.classList.add('hidden');
    elements.playerControls.classList.remove('hidden');
    elements.playbackBar.classList.remove('hidden');

    // Populate current chunk text
    if (state.chunks && state.chunks[state.currentChunkIndex]) {
        elements.currentText.textContent = state.chunks[state.currentChunkIndex];
    }

    updateStats();
    updateProgress();
    updateCatalogUI();
    updateViewerVisibility();
}

function showUploadZone() {
    elements.playerControls.classList.add('hidden');
    elements.playbackBar.classList.add('hidden');
    elements.dropzone.classList.remove('hidden');
    state.currentDocID = null;
    updateCatalogUI();
}

function sanitizeToAscii(str) {
    if (!str) return "";

    return str
        // 1. Convert all whitespace (nbsp, tabs, etc.) to standard spaces
        .replace(/\s+/g, ' ')
        // 2. Remove any character that is NOT in the printable ASCII range (32-126)
        // This removes the "Mathematical Tilde" (8764) and fancy quotes.
        .replace(/[^\x20-\x7E]/g, "")
        // 3. Collapse multiple spaces created by removals
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Cleans PDF text by:
 * 1. Normalizing all whitespace (NBSP, tabs, etc.) to standard spaces (32).
 * 2. Collapsing multiple spaces into one.
 * 3. Removing non-printable/control characters.
 * 4. Normalizing Unicode (handles those weird tildes and accents).
 */
function sanitizePdfText(str) {
    if (!str) return "";

    return str
        // 1. Normalize Unicode
        .normalize('NFC')
        // 2. Replace horizontal whitespace with standard space, preserve \n
        .replace(/[^\S\r\n]+/g, ' ')
        // 3. Remove non-printable/control characters (except \n)
        .replace(/[\x00-\x09\x0B-\x1F\x7F-\x9F]/g, "")
        .trim();
}

async function extractText() {
    let fullText = '';
    const numPages = state.pdf.numPages;

    for (let i = 1; i <= numPages; i++) {
        const page = await state.pdf.getPage(i);
        const textContent = await page.getTextContent();
        const pageText = textContent.items.map(item => item.str).join(' ');
        fullText += pageText + ' ';
    }

    fullText = sanitizeToAscii(fullText);

    state.unfilteredFullText = fullText.trim();
    state.fullText = filterText(state.unfilteredFullText);
    chunkText(state.fullText);
    updateStats();
}

function filterText(text) {
    if (!state.settings.skipPhrases || state.settings.skipPhrases.length === 0) return text;

    let filtered = text;
    state.settings.skipPhrases.forEach(phrase => {
        const lowerPhrase = phrase.toLowerCase();
        let pos = filtered.toLowerCase().indexOf(lowerPhrase);
        while (pos !== -1) {
            filtered = filtered.substring(0, pos) + filtered.substring(pos + phrase.length);
            pos = filtered.toLowerCase().indexOf(lowerPhrase);
        }
    });

    // Clean up multiple spaces/newlines left behind
    return filtered.replace(/\s\s+/g, ' ').trim();
}

async function reProcessText() {
    const wasPlaying = state.isPlaying;
    const oldIndex = state.currentChunkIndex;

    await stopPlayback();

    state.fullText = filterText(state.unfilteredFullText);
    chunkText(state.fullText);

    // Try to stay on approximately the same relative progress
    state.currentChunkIndex = Math.min(oldIndex, state.chunks.length - 1);

    // Explicitly update displayed text
    if (state.chunks[state.currentChunkIndex]) {
        elements.currentText.textContent = state.chunks[state.currentChunkIndex];
    }

    // Update catalog entry with new filtered content
    upsertCatalog();
    await saveState();

    showPlayer();
    updateStats();
    updateProgress();

    if (wasPlaying) startPlayback();
}

function chunkText(text) {
    const words = text.split(/\s+/).filter(w => w !== '');
    state.chunks = [];
    const softLimit = state.settings.chunkSize || 50;
    const lookAhead = 30;

    let i = 0;
    while (i < words.length) {
        let chunkEnd = i + softLimit;

        // If we have enough words left to look ahead
        if (chunkEnd < words.length) {
            let foundSentenceEnd = false;
            // Search for sentence ending within lookAhead range
            for (let j = 0; j < lookAhead && (chunkEnd + j) < words.length; j++) {
                const word = words[chunkEnd + j];
                // Check if word ends with . ? !
                if (/[.?!]$/.test(word)) {
                    chunkEnd = chunkEnd + j + 1;
                    foundSentenceEnd = true;
                    break;
                }
            }

            // If No sentence end found, just take the extra lookAhead words
            if (!foundSentenceEnd) {
                chunkEnd = Math.min(chunkEnd + lookAhead, words.length);
            }
        } else {
            chunkEnd = words.length;
        }

        const chunk = words.slice(i, chunkEnd).join(' ');
        state.chunks.push(chunk);
        i = chunkEnd;
    }

    state.currentChunkIndex = 0;
}

function updateStats() {
    const wordCount = state.fullText.split(/\s+/).length;
    const totalPages = state.pdf ? state.pdf.numPages : state.numPages;
    elements.fileStats.textContent = `${wordCount} words · ${totalPages} pages`;
    updateProgress();
}

async function updateProgress() {
    if (state.chunks.length === 0) return;

    const progress = (state.currentChunkIndex / state.chunks.length) * 100;
    elements.progressBarFill.style.width = `${progress}%`;
    elements.progressPercent.textContent = `${Math.round(progress)}%`;

    const totalWords = state.fullText.split(/\s+/).length;
    const readWords = state.chunks.slice(0, state.currentChunkIndex).join(' ').split(/\s+/).length;
    elements.wordProgress.textContent = `${readWords} / ${totalWords} words`;

    await saveState();
}

function togglePlayback() {
    if (state.isPlaying) {
        if (state.isPaused) {
            resumePlayback();
        } else {
            pausePlayback();
        }
    } else {
        startPlayback();
    }
}

function startPlayback() {
    if (state.chunks.length === 0) return;
    state.isPlaying = true;
    state.isPaused = false;
    state.lastEnqueuedIndex = state.currentChunkIndex - 1;
    updatePlayIcons();
    updateViewerVisibility();

    // Fill the buffer initially
    fillBuffer();
}

function fillBuffer() {
    while (state.isPlaying && !state.isPaused &&
        state.lastEnqueuedIndex < state.currentChunkIndex + state.bufferSize &&
        state.lastEnqueuedIndex < state.chunks.length - 1) {
        state.lastEnqueuedIndex++;
        enqueueChunk(state.lastEnqueuedIndex);
    }
}

function enqueueChunk(index) {
    const text = state.chunks[index];
    const utterance = new SpeechSynthesisUtterance(text);

    if (state.settings.voice) utterance.voice = state.settings.voice;
    utterance.rate = state.settings.rate;
    utterance.pitch = state.settings.pitch;
    utterance.volume = state.settings.volume;

    utterance.onstart = async () => {
        if (!state.isPlaying) return;
        state.currentChunkIndex = index;
        elements.currentText.textContent = text;
        await updateProgress();
        // Try to add one more to the end of the queue as one started
        fillBuffer();
    };

    utterance.onend = () => {
        if (state.currentChunkIndex >= state.chunks.length - 1) {
            stopPlayback();
        }
    };

    utterance.onerror = (e) => {
        console.error('Speech error:', e);
        // On error, the queue might get stuck, so we might need to restart
    };

    window.speechSynthesis.speak(utterance);
}

function pausePlayback() {
    window.speechSynthesis.pause();
    state.isPaused = true;
    updatePlayIcons();
}

function resumePlayback() {
    window.speechSynthesis.resume();
    state.isPaused = false;
    updatePlayIcons();
}

async function stopPlayback() {
    window.speechSynthesis.cancel();
    state.isPlaying = false;
    state.isPaused = false;
    // Removed state.currentChunkIndex = 0; to preserve progress
    state.lastEnqueuedIndex = -1;
    updatePlayIcons();
    await updateProgress();
    updateViewerVisibility();
}

function restartCurrentChunk() {
    window.speechSynthesis.cancel();
    // Restart from the current index by refilling buffer
    state.lastEnqueuedIndex = state.currentChunkIndex - 1;
    fillBuffer();
}

async function navigateChunk(direction) {
    const newIndex = state.currentChunkIndex + direction;
    if (newIndex >= 0 && newIndex < state.chunks.length) {
        state.currentChunkIndex = newIndex;

        // Always update the displayed text
        if (state.chunks[state.currentChunkIndex]) {
            elements.currentText.textContent = state.chunks[state.currentChunkIndex];
        }

        await updateProgress();
        if (state.isPlaying) {
            restartCurrentChunk();
        }
    }
}

function updatePlayIcons() {
    if (state.isPlaying && !state.isPaused) {
        elements.playIcon.classList.add('hidden');
        elements.pauseIcon.classList.remove('hidden');
    } else {
        elements.playIcon.classList.remove('hidden');
        elements.pauseIcon.classList.add('hidden');
    }
}

function updateViewerVisibility() {
    if (state.settings.showText && !elements.playerControls.classList.contains('hidden')) {
        elements.readingViewer.classList.remove('hidden');
    } else {
        elements.readingViewer.classList.add('hidden');
    }
}

// --- Persistence & Catalog ---

async function saveState() {
    // Update current doc in catalog before saving
    if (state.currentDocID) {
        upsertCatalog();
    }

    const dataToSave = {
        catalog: state.catalog,
        currentDocID: state.currentDocID,
        settings: {
            voiceURI: state.settings.voiceURI,
            rate: state.settings.rate,
            pitch: state.settings.pitch,
            volume: state.settings.volume,
            fontSize: state.settings.fontSize,
            chunkSize: state.settings.chunkSize,
            textAlign: state.settings.textAlign,
            showText: state.settings.showText,
            skipPhrases: state.settings.skipPhrases
        }
    };

    try {
        await db.set('state', dataToSave);
    } catch (e) {
        console.error('Persistence failed:', e);
    }
}

async function loadState() {
    try {
        const data = await db.get('state');
        if (!data) return;

        state.catalog = data.catalog || [];
        state.currentDocID = data.currentDocID;

        // Restore settings
        state.settings = { ...state.settings, ...data.settings };

        // Restore current document if any
        if (state.currentDocID) {
            const currentDoc = state.catalog.find(d => d.id === state.currentDocID);
            if (currentDoc) {
                await restoreDocument(currentDoc);
            }
        } else {
            updateCatalogUI();
        }

        // Apply visual settings to UI
        elements.rateRange.value = state.settings.rate;
        elements.rateVal.textContent = state.settings.rate + 'x';
        elements.pitchRange.value = state.settings.pitch;
        elements.pitchVal.textContent = state.settings.pitch;
        elements.volumeRange.value = state.settings.volume;
        elements.volumeVal.textContent = Math.round(state.settings.volume * 100) + '%';
        elements.fontSizeRange.value = state.settings.fontSize || 1.2;
        elements.fontSizeVal.textContent = (state.settings.fontSize || 1.2) + 'rem';
        elements.currentText.style.fontSize = (state.settings.fontSize || 1.2) + 'rem';

        elements.chunkSizeRange.value = state.settings.chunkSize || 50;
        elements.chunkSizeVal.textContent = (state.settings.chunkSize || 50) + ' words';

        applyAlignmentUI();
        elements.showTextToggle.checked = state.settings.showText;
        elements.skipPhrasesInput.value = (state.settings.skipPhrases || []).join('\n');

    } catch (e) {
        console.error('Failed to load state:', e);
    }
}

function upsertCatalog() {
    const docState = {
        id: state.currentDocID,
        fileName: state.fileName,
        numPages: state.numPages,
        unfilteredFullText: state.unfilteredFullText,
        fullText: state.fullText,
        chunks: state.chunks,
        currentChunkIndex: state.currentChunkIndex,
        skipPhrases: state.settings.skipPhrases || []
    };
    const existingIndex = state.catalog.findIndex(d => d.id === state.currentDocID);
    if (existingIndex !== -1) {
        state.catalog[existingIndex] = docState;
    } else {
        state.catalog.unshift(docState); // Add new ones to top
    }
}

function updateCatalogUI() {
    let catalogHtml = `
        <div class="add-new-item" id="addNewDocBtn">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="12" y1="5" x2="12" y2="19"></line>
                <line x1="5" y1="12" x2="19" y2="12"></line>
            </svg>
            <span>Add New Document</span>
        </div>
    `;

    if (state.catalog.length === 0) {
        elements.catalogList.innerHTML = catalogHtml + '<div class="empty-catalog">No other documents</div>';
    } else {
        catalogHtml += state.catalog.map(doc => `
            <div class="catalog-item ${doc.id === state.currentDocID ? 'active' : ''}" data-id="${doc.id}">
                <div class="catalog-item-content">
                    <span class="catalog-item-title">${doc.fileName}</span>
                    <span class="catalog-item-stats">${Math.round((doc.currentChunkIndex / (doc.chunks.length || 1)) * 100)}% read</span>
                </div>
                <button class="delete-doc-btn" data-id="${doc.id}" title="Remove Document">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                        stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <line x1="18" y1="6" x2="6" y2="18"></line>
                        <line x1="6" y1="6" x2="18" y2="18"></line>
                    </svg>
                </button>
            </div>
        `).join('');
        elements.catalogList.innerHTML = catalogHtml;
    }

    // Add listeners
    document.getElementById('addNewDocBtn').addEventListener('click', addNewDocHandler);

    document.querySelectorAll('.catalog-item').forEach(item => {
        item.addEventListener('click', async (e) => {
            // Don't switch if delete button was clicked
            if (e.target.closest('.delete-doc-btn')) return;

            const id = item.dataset.id;
            if (window.innerWidth <= 768) {
                closeSidebar();
            }
            if (id === state.currentDocID) return;
            await switchDocument(id);
        });
    });

    // Add delete listeners
    document.querySelectorAll('.delete-doc-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = btn.dataset.id;
            if (confirm('Are you sure you want to remove this document?')) {
                await deleteDocument(id);
            }
        });
    });
}

async function deleteDocument(id) {
    // If we're deleting the current doc, close it first
    if (id === state.currentDocID) {
        await closeDocument();
    }

    // Remove from in-memory catalog
    state.catalog = state.catalog.filter(doc => doc.id !== id);

    // Save updated catalog to DB
    await saveState();
    updateCatalogUI();
}

async function switchDocument(id) {
    if (state.currentDocID) await saveState();

    await stopPlayback();
    const doc = state.catalog.find(d => d.id === id);
    if (doc) {
        state.currentDocID = id;
        await restoreDocument(doc);
        await saveState();
    }
}

async function restoreDocument(doc) {
    state.fileName = doc.fileName;
    state.numPages = doc.numPages;
    state.unfilteredFullText = doc.unfilteredFullText || doc.fullText; // Backwards compat
    state.fullText = doc.fullText;
    state.chunks = doc.chunks;
    state.currentChunkIndex = doc.currentChunkIndex;

    // Restore book-specific skip phrases
    state.settings.skipPhrases = doc.skipPhrases || [];
    elements.skipPhrasesInput.value = state.settings.skipPhrases.join('\n');

    // Note: state.pdf will be null until re-uploaded or re-processed 
    // unless we store the arraybuffer, but we have fullText and chunks so it's fine for playback.

    showPlayer();

    // Always re-process to ensure current phrases are applied to the text
    if (state.unfilteredFullText) {
        await reProcessText();
    }
}

async function closeDocument() {
    stopPlayback();

    // Remove from catalog
    state.catalog = state.catalog.filter(d => d.id !== state.currentDocID);

    showUploadZone();
    await saveState();
}

function applyAlignmentUI() {
    const align = state.settings.textAlign || 'justify';
    elements.currentText.style.textAlign = align;
    elements.alignBtns.forEach(btn => {
        if (btn.dataset.align === align) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });
}
