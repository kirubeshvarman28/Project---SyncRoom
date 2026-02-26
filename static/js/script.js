// --- UI Notifications (Toasts) ---

function showToast(message, type = 'success', action = null) {
    const container = document.getElementById('toastContainer');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;

    let icon = 'fa-check-circle';
    if (type === 'error') icon = 'fa-exclamation-circle';
    if (type === 'info') icon = 'fa-info-circle';
    if (type === 'warning') icon = 'fa-exclamation-triangle';

    toast.innerHTML = `
        <i class="fas ${icon}"></i>
        <span>${message}</span>
    `;

    if (action) {
        const actionBtn = document.createElement('button');
        actionBtn.className = 'toast-action';
        actionBtn.textContent = action.label;
        actionBtn.onclick = (e) => {
            e.stopPropagation();
            action.callback();
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 400);
        };
        toast.appendChild(actionBtn);
    }

    container.appendChild(toast);

    // Trigger animation
    setTimeout(() => toast.classList.add('show'), 100);

    // Auto-remove
    const duration = action ? 6000 : 4000;
    setTimeout(() => {
        if (toast.parentElement) {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 400);
        }
    }, duration);
}

// --- Custom Confirmation Modal ---

function showConfirm(message, onConfirm) {
    const modal = document.getElementById('confirmModal');
    const msgEl = document.getElementById('confirmMessage');
    const confirmBtn = document.getElementById('confirmBtn');
    const cancelBtn = document.getElementById('confirmCancel');

    if (!modal || !msgEl || !confirmBtn || !cancelBtn) return;

    msgEl.textContent = message;
    modal.classList.add('show');

    const closeIcon = () => {
        modal.classList.remove('show');
    };

    const handleConfirm = () => {
        onConfirm();
        closeIcon();
        cleanup();
    };

    const handleCancel = () => {
        closeIcon();
        cleanup();
    };

    const cleanup = () => {
        confirmBtn.removeEventListener('click', handleConfirm);
        cancelBtn.removeEventListener('click', handleCancel);
    };

    confirmBtn.addEventListener('click', handleConfirm);
    cancelBtn.addEventListener('click', handleCancel);
}

// --- Room Management ---

async function joinRoom() {
    const input = document.getElementById('roomCodeInput');
    const code = input.value.trim().toUpperCase();
    if (code.length === 6) {
        try {
            const response = await fetch(`/api/check_room/${code}`);
            const data = await response.json();
            if (data.exists) {
                window.location.href = `/room/${code}`;
            } else {
                showToast(`Room "${code}" not found.`, 'error');
                input.value = ''; // Clear for retry
            }
        } catch (err) {
            console.error('Room check error:', err);
            window.location.href = `/room/${code}`; // Fallback to direct navigation
        }
    } else {
        showToast('Please enter a 6-character room code.', 'error');
    }
}

function copyRoomLink() {
    navigator.clipboard.writeText(window.location.href);
    showToast('Room link copied to clipboard!', 'info');
}

// --- Recent Rooms ---

document.addEventListener('DOMContentLoaded', () => {
    const recentList = document.getElementById('recentRoomsList');
    if (recentList) {
        const recent = JSON.parse(localStorage.getItem('recentRooms') || '[]');
        if (recent.length > 0) {
            recentList.innerHTML = '';
            recent.forEach(code => {
                const item = document.createElement('div');
                item.className = 'recent-item';
                item.innerHTML = `
                    <span>${code}</span>
                    <a href="/room/${code}" class="btn-join"><i class="fas fa-arrow-right"></i></a>
                `;
                recentList.appendChild(item);
            });
        }
    }

    // --- Room Entry Keyboard Support ---
    const roomCodeInput = document.getElementById('roomCodeInput');
    if (roomCodeInput) {
        roomCodeInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                joinRoom();
            }
        });

        // Auto-join when 6 characters are reached (optional but nice)
        roomCodeInput.addEventListener('input', () => {
            roomCodeInput.value = roomCodeInput.value.toUpperCase();
            if (roomCodeInput.value.trim().length === 6) {
                // Optionally auto-focus button or just wait for enter
            }
        });
    }

    // --- File Upload Logic ---
    const dropZone = document.getElementById('dropZone');
    const fileInput = document.getElementById('fileInput');

    if (dropZone) {
        // Start expiry timer update
        setInterval(updateExpiries, 1000);
        updateExpiries(); // Initial call

        dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropZone.classList.add('dragover');
        });

        dropZone.addEventListener('dragleave', () => {
            dropZone.classList.remove('dragover');
        });

        dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropZone.classList.remove('dragover');
            handleFiles(e.dataTransfer.files);
        });

        fileInput.addEventListener('change', () => {
            handleFiles(fileInput.files);
        });

        // Start member count heartbeat
        startMemberHeartbeat();

        // Start file sync polling
        setInterval(syncFiles, 5000);
        syncFiles(); // Initial sync
    }
});

async function startMemberHeartbeat() {
    const roomCode = window.location.pathname.split('/').pop();
    const countSpan = document.getElementById('memberCount');

    if (!countSpan) return;

    setInterval(async () => {
        try {
            const response = await fetch(`/api/room/${roomCode}/heartbeat`, {
                method: 'POST'
            });
            const data = await response.json();
            if (data.member_count) {
                countSpan.textContent = data.member_count;
            }
        } catch (err) {
            console.error('Heartbeat error:', err);
        }
    }, 5000); // Poll every 5 seconds
}

async function handleFiles(files) {
    if (files.length === 0) return;

    const formData = new FormData();
    for (let file of files) {
        formData.append('file', file);
    }

    // Add expiry value
    const expirySelect = document.getElementById('expirySelect');
    if (expirySelect) {
        formData.append('expiry', expirySelect.value);
    }

    const roomCode = window.location.pathname.split('/').pop();
    const progressContainer = document.getElementById('uploadProgress');
    const progressBar = document.getElementById('progressBar');

    progressContainer.style.display = 'block';

    try {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `/api/room/${roomCode}/upload`, true);

        xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
                const percent = (e.loaded / e.total) * 100;
                progressBar.style.width = percent + '%';
            }
        };

        xhr.onload = () => {
            if (xhr.status === 200) {
                showToast('Files uploaded successfully!', 'success');
                progressContainer.style.display = 'none';
                progressBar.style.width = '0%';
                syncFiles(true); // Immediate sync
            } else {
                showToast('Upload failed', 'error');
                progressContainer.style.display = 'none';
            }
        };

        xhr.send(formData);
    } catch (err) {
        console.error(err);
        showToast('An error occurred during upload', 'error');
        progressContainer.style.display = 'none';
    }
}

function updateExpiries() {
    const cards = document.querySelectorAll('.file-card');
    cards.forEach(card => {
        const uploadTimeStr = card.getAttribute('data-upload-time');
        const expiryMinutes = parseInt(card.getAttribute('data-expiry-minutes') || '5');

        if (!uploadTimeStr) return;
        const timerSpan = card.querySelector('.expiry-timer');
        if (!timerSpan) return;

        if (expiryMinutes === -1) {
            timerSpan.textContent = "∞ (Permanent)";
            return;
        }

        const uploadTime = new Date(uploadTimeStr + 'Z');
        const now = new Date();
        const expiryTime = new Date(uploadTime.getTime() + expiryMinutes * 60 * 1000);
        const diff = expiryTime - now;

        if (diff <= 0) {
            timerSpan.textContent = "Expired";
            card.style.opacity = '0.5';
            setTimeout(() => card.remove(), 2000);
        } else {
            const minLeft = Math.floor(diff / 60000);
            const secLeft = Math.floor((diff % 60000) / 1000);

            if (minLeft >= 60) {
                const hours = Math.floor(minLeft / 60);
                const mins = minLeft % 60;
                timerSpan.textContent = `${hours}h ${mins}m`;
            } else {
                timerSpan.textContent = `${minLeft}:${secLeft.toString().padStart(2, '0')}`;
            }
        }
    });
}
let pendingDeletions = {};

async function deleteFile(code, filename, cardId) {
    const card = document.getElementById(cardId);
    if (!card) return;

    showConfirm(`Are you sure you want to delete "${filename}"?`, () => {
        // Step 1: Visual feedback immediately (dim and disable card)
        card.style.opacity = '0.4';
        card.style.pointerEvents = 'none';
        card.style.filter = 'grayscale(1)';

        // Step 2: Set deletion timeout
        const timeoutId = setTimeout(async () => {
            try {
                const response = await fetch(`/api/room/${code}/delete/${filename}`, {
                    method: 'POST'
                });

                if (response.ok) {
                    card.style.opacity = '0';
                    card.style.transform = 'scale(0.95)';
                    setTimeout(() => {
                        card.remove();
                        updateFileCount();
                    }, 300);
                } else {
                    const data = await response.json();
                    showToast(data.error || 'Delete failed', 'error');
                    restoreCard(card);
                }
            } catch (err) {
                console.error('Delete error:', err);
                showToast('An error occurred during deletion', 'error');
                restoreCard(card);
            }
            delete pendingDeletions[cardId];
        }, 6000);

        pendingDeletions[cardId] = timeoutId;

        // Step 3: Show toast with Undo
        showToast(`Deleting "${filename}"...`, 'warning', {
            label: 'Undo',
            callback: () => {
                clearTimeout(pendingDeletions[cardId]);
                delete pendingDeletions[cardId];
                restoreCard(card);
                showToast('Deletion undone', 'info');
            }
        });
    });
}

function restoreCard(card) {
    card.style.opacity = '1';
    card.style.pointerEvents = 'auto';
    card.style.filter = 'none';
}

function updateFileCount() {
    const countSpan = document.querySelector('.file-count');
    if (countSpan) {
        const currentCount = document.querySelectorAll('.file-card').length;
        countSpan.textContent = `${currentCount} files`;
    }
}

async function syncFiles(manual = false) {
    const roomCode = window.location.pathname.split('/').pop();
    const grid = document.getElementById('filesGrid');
    if (!grid) return;

    try {
        const response = await fetch(`/api/room/${roomCode}/files`);
        const data = await response.json();

        // Simple comparison: check if filenames and counts match
        const currentCards = document.querySelectorAll('.file-card');
        const currentFilenames = Array.from(currentCards).map(c => c.querySelector('.file-name').textContent);

        const newFilenames = data.files.map(f => f.filename);

        // If changed, re-render
        if (manual || JSON.stringify(currentFilenames.sort()) !== JSON.stringify(newFilenames.sort())) {
            renderFileGrid(data.files, roomCode);
        }
    } catch (err) {
        console.error('Sync error:', err);
    }
}

function renderFileGrid(files, roomCode) {
    const grid = document.getElementById('filesGrid');
    if (!grid) return;

    if (files.length === 0) {
        grid.innerHTML = `
            <div class="empty-files">
                <p>No files uploaded yet. Be the first!</p>
            </div>
        `;
        updateFileCount();
        return;
    }

    grid.innerHTML = '';
    files.forEach((file, index) => {
        const card = document.createElement('div');
        card.className = 'file-card';
        card.id = `file-${index + 1}`;
        card.setAttribute('data-upload-time', file.upload_date);
        card.setAttribute('data-expiry-minutes', file.expiry_minutes);

        card.innerHTML = `
            <div class="file-icon">
                <i class="fas fa-file-alt"></i>
            </div>
            <div class="file-details">
                <span class="file-name">${file.filename}</span>
                <span class="file-meta">
                    Expires in: <span class="expiry-timer">Calculating...</span>
                </span>
            </div>
            <div class="file-actions">
                <a href="${file.download_url}" class="btn-download" download>
                    <i class="fas fa-download"></i>
                </a>
                <button class="btn-delete" onclick="deleteFile('${roomCode}', '${file.filename}', 'file-${index + 1}')">
                    <i class="fas fa-trash-alt"></i>
                </button>
            </div>
        `;
        grid.appendChild(card);
    });

    updateFileCount();
    updateExpiries(); // Immediate refresh of timers
}
