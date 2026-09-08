// Jellyfin Custom Enhancement:
// 1. PotPlayer-Style Aggressive Full-Episode Buffering Engine (7200s, 2GB Buffer)
// 2. PotPlayer-Style Bottom Control Bar HUD (Realtime Buffer, 88VIP Speed, Decode Switcher)
// 3. Persistent "最近观看" (Recently Watched) Section with Playback Progress & History

(function() {
    'use strict';

    // =========================================================================
    // 1. PotPlayer-Style Aggressive Buffering Engine
    // =========================================================================
    function applyHlsBufferConfig(HlsClass) {
        if (!HlsClass) return;
        if (HlsClass.DefaultConfig) {
            HlsClass.DefaultConfig.maxBufferLength = 7200; // 2 hours buffer ahead
            HlsClass.DefaultConfig.maxMaxBufferLength = 14400; // 4 hours
            HlsClass.DefaultConfig.maxBufferSize = 2 * 1024 * 1024 * 1024; // 2GB buffer in RAM
            HlsClass.DefaultConfig.backBufferLength = 1800; // 30 minutes back buffer
            HlsClass.DefaultConfig.maxBufferHole = 0.5;
            HlsClass.DefaultConfig.lowLatencyMode = false;
            HlsClass.DefaultConfig.startFragPrefetch = true;
            HlsClass.DefaultConfig.progressive = true;
        }
    }

    let activeHlsInstance = null;
    let totalBytesDownloaded = 0;
    let bytesInWindow = 0;
    let windowStartTime = Date.now();
    let lastChunkDownloadedTime = 0;
    let currentSpeedBps = 0;

    function wrapHlsConstructor(OriginalHls) {
        if (!OriginalHls || OriginalHls.__potplayerWrapped) return OriginalHls;
        function EnhancedHls(userConfig) {
            userConfig = userConfig || {};
            userConfig.maxBufferLength = 7200;
            userConfig.maxMaxBufferLength = 14400;
            userConfig.maxBufferSize = 2 * 1024 * 1024 * 1024;
            userConfig.backBufferLength = 1800;
            userConfig.maxBufferHole = 0.5;
            userConfig.lowLatencyMode = false;
            userConfig.startFragPrefetch = true;
            userConfig.progressive = true;
            userConfig.manifestLoadingTimeOut = 30000;
            console.log('[PotPlayer-Buffer] Instantiating Hls with continuous full episode buffer (7200s, 2GB)');
            const inst = new OriginalHls(userConfig);
            activeHlsInstance = inst;
            window.__potplayer_active_hls = inst;

            if (OriginalHls.Events && OriginalHls.Events.FRAG_LOADED) {
                inst.on(OriginalHls.Events.FRAG_LOADED, (event, data) => {
                    if (data && data.stats) {
                        lastChunkDownloadedTime = Date.now();
                        const loaded = data.stats.total || data.stats.loaded || 0;
                        if (loaded > 0) {
                            bytesInWindow += loaded;
                            totalBytesDownloaded += loaded;
                        }
                    }
                });
            }
            return inst;
        }
        EnhancedHls.prototype = OriginalHls.prototype;
        Object.assign(EnhancedHls, OriginalHls);
        EnhancedHls.DefaultConfig = OriginalHls.DefaultConfig;
        applyHlsBufferConfig(EnhancedHls);
        EnhancedHls.__potplayerWrapped = true;
        return EnhancedHls;
    }

    let _hls = window.Hls ? wrapHlsConstructor(window.Hls) : null;
    try {
        Object.defineProperty(window, 'Hls', {
            get() { return _hls; },
            set(val) {
                _hls = wrapHlsConstructor(val);
                console.log('[PotPlayer-Buffer] window.Hls hooked successfully.');
            },
            configurable: true
        });
    } catch (e) {
        if (window.Hls) {
            window.Hls = wrapHlsConstructor(window.Hls);
        }
    }

    // Direct Play Video Pre-buffering
    document.addEventListener('play', (e) => {
        if (e.target && e.target.tagName === 'VIDEO') {
            const video = e.target;
            video.preload = 'auto';
            console.log('[PotPlayer-Buffer] Video element detected. Set preload=auto for full pre-buffering.');
        }
    }, true);

    // Network throughput hook via XMLHttpRequest for video segments
    try {
        const origXhrOpen = XMLHttpRequest.prototype.open;
        const origXhrSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function(method, url) {
            this._potplayer_url = typeof url === 'string' ? url : '';
            return origXhrOpen.apply(this, arguments);
        };
        XMLHttpRequest.prototype.send = function() {
            const url = this._potplayer_url || '';
            if (url.includes('/Videos/') || url.includes('/hls') || url.includes('.ts') || url.includes('.m4s') || url.includes('stream')) {
                let prevLoaded = 0;
                this.addEventListener('progress', (e) => {
                    if (e.loaded > prevLoaded) {
                        const delta = e.loaded - prevLoaded;
                        prevLoaded = e.loaded;
                        bytesInWindow += delta;
                        totalBytesDownloaded += delta;
                        lastChunkDownloadedTime = Date.now();
                    }
                });
                this.addEventListener('load', () => {
                    lastChunkDownloadedTime = Date.now();
                });
            }
            return origXhrSend.apply(this, arguments);
        };
    } catch (e) {}

    // =========================================================================
    // 2. PotPlayer-Style Bottom Control Bar HUD & Realtime Monitoring
    // =========================================================================
    const hudStyle = document.createElement('style');
    hudStyle.id = 'potplayer-hud-style';
    hudStyle.textContent = `
        /* PotPlayer HUD Container */
        .videoOsdBottom-maincontrols .buttons .osdTimeText { margin-right: 0.6em !important; }
        .potplayer-hud {
            display: inline-flex !important;
            align-items: center !important;
            gap: 6px !important;
            margin-left: 0.8em !important;
            margin-right: auto !important;
            user-select: none !important;
            z-index: 100 !important;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif !important;
        }

        .potplayer-badge {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            height: 24px;
            padding: 0 8px;
            border-radius: 4px;
            font-size: 11px;
            font-weight: 600;
            letter-spacing: 0.3px;
            background: rgba(30, 30, 30, 0.85);
            border: 1px solid rgba(255, 255, 255, 0.18);
            color: #e0e0e0;
            box-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
            transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
            white-space: nowrap;
        }

        button.potplayer-badge {
            cursor: pointer;
            outline: none;
        }
        button.potplayer-badge:hover {
            background: rgba(50, 50, 50, 0.95);
            border-color: rgba(255, 255, 255, 0.35);
            transform: translateY(-1px);
        }

        /* H/W Decode Button */
        .potplayer-badge-hw {
            background: rgba(45, 32, 10, 0.9) !important;
            border: 1px solid rgba(255, 179, 0, 0.6) !important;
            color: #ffb300 !important;
        }
        .potplayer-badge-hw:hover {
            background: rgba(65, 48, 15, 0.95) !important;
            box-shadow: 0 0 10px rgba(255, 179, 0, 0.45) !important;
        }

        .potplayer-badge-sw {
            background: rgba(10, 38, 48, 0.9) !important;
            border: 1px solid rgba(0, 229, 255, 0.6) !important;
            color: #00e5ff !important;
        }
        .potplayer-badge-sw:hover {
            background: rgba(15, 55, 70, 0.95) !important;
            box-shadow: 0 0 10px rgba(0, 229, 255, 0.45) !important;
        }

        /* Codecs & Audio */
        .potplayer-badge-codec {
            color: #ffffff !important;
            background: rgba(25, 25, 28, 0.85) !important;
        }
        .potplayer-badge-audio {
            color: #b0bec5 !important;
            background: rgba(25, 25, 28, 0.85) !important;
        }
        .potplayer-badge-audio:hover {
            color: #ffffff !important;
            border-color: rgba(255, 255, 255, 0.4) !important;
        }

        /* Speed badge */
        .potplayer-badge-speed {
            font-variant-numeric: tabular-nums;
            min-width: 78px;
            justify-content: center;
        }
        .potplayer-speed-fast {
            color: #00e676 !important; /* 88VIP full speed green */
            border-color: rgba(0, 230, 118, 0.5) !important;
            background: rgba(0, 50, 20, 0.6) !important;
        }
        .potplayer-speed-normal {
            color: #ffb300 !important;
            border-color: rgba(255, 179, 0, 0.4) !important;
        }
        .potplayer-speed-slow {
            color: #ff9100 !important;
            border-color: rgba(255, 145, 0, 0.4) !important;
        }
        .potplayer-speed-idle {
            color: rgba(255, 255, 255, 0.4) !important;
        }

        /* Buffer badge */
        .potplayer-badge-buffer {
            font-variant-numeric: tabular-nums;
        }
        .potplayer-buffer-full {
            color: #00e676 !important;
            border-color: rgba(0, 230, 118, 0.5) !important;
        }

        /* Floating Dropdown Menu */
        .potplayer-menu {
            position: absolute;
            bottom: 56px;
            left: 140px;
            background: rgba(22, 22, 26, 0.97);
            backdrop-filter: blur(18px);
            border: 1px solid rgba(255, 255, 255, 0.16);
            border-radius: 8px;
            padding: 6px;
            min-width: 290px;
            box-shadow: 0 12px 30px rgba(0, 0, 0, 0.7);
            z-index: 10000;
            display: flex;
            flex-direction: column;
            gap: 2px;
            animation: potplayerFadeIn 0.15s ease-out;
        }

        @keyframes potplayerFadeIn {
            from { opacity: 0; transform: translateY(6px); }
            to { opacity: 1; transform: translateY(0); }
        }

        .potplayer-menu-header {
            font-size: 11px;
            font-weight: 700;
            color: rgba(255, 255, 255, 0.5);
            padding: 6px 10px 4px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }

        .potplayer-menu-item {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 8px 10px;
            border-radius: 6px;
            cursor: pointer;
            transition: background 0.15s ease;
        }
        .potplayer-menu-item:hover {
            background: rgba(255, 255, 255, 0.1);
        }
        .potplayer-menu-item.active {
            background: rgba(255, 179, 0, 0.15);
            border-left: 3px solid #ffb300;
        }

        .potplayer-menu-icon {
            font-size: 16px;
            flex-shrink: 0;
        }
        .potplayer-menu-title {
            font-size: 13px;
            font-weight: 600;
            color: #ffffff;
        }
        .potplayer-menu-desc {
            font-size: 11px;
            color: rgba(255, 255, 255, 0.55);
            margin-top: 1px;
        }
        .potplayer-menu-divider {
            height: 1px;
            background: rgba(255, 255, 255, 0.1);
            margin: 4px 6px;
        }

        /* High Visibility Seekbar Buffer Glowing Bar */
        .mdl-slider-background-upper {
            background: linear-gradient(90deg, rgba(255, 179, 0, 0.45), rgba(255, 215, 0, 0.65)) !important;
            box-shadow: 0 0 8px rgba(255, 193, 7, 0.4) !important;
            border-radius: 3px !important;
            height: 100% !important;
            opacity: 1 !important;
            display: block !important;
        }

        @media (max-width: 768px) {
            .potplayer-badge-codec,
            .potplayer-badge-audio {
                display: none !important;
            }
        }
    `;
    if (!document.getElementById('potplayer-hud-style')) {
        document.head.appendChild(hudStyle);
    }

    let cachedSessionInfo = {
        playMethod: 'DirectPlay',
        videoCodec: 'H264',
        audioCodec: 'AAC 2.0',
        lastFetch: 0
    };

    async function fetchSessionInfo() {
        const now = Date.now();
        if (now - cachedSessionInfo.lastFetch < 3000) return;
        cachedSessionInfo.lastFetch = now;
        try {
            if (window.ApiClient) {
                const deviceId = window.ApiClient.deviceId ? window.ApiClient.deviceId() : '';
                const sessions = await window.ApiClient.getSessions({ deviceId });
                const s = sessions && sessions.find(item => (deviceId && item.DeviceId === deviceId) || item.NowPlayingItem);
                if (s && s.NowPlayingItem) {
                    const isTranscode = s.PlayState?.PlayMethod === 'Transcode';
                    const isDirectStream = s.PlayState?.PlayMethod === 'DirectStream';
                    cachedSessionInfo.playMethod = isTranscode ? 'Transcode' : (isDirectStream ? 'DirectStream' : 'DirectPlay');

                    if (s.TranscodingInfo) {
                        cachedSessionInfo.videoCodec = (s.TranscodingInfo.VideoCodec || 'H264').toUpperCase();
                        let a = (s.TranscodingInfo.AudioCodec || 'AAC').toUpperCase();
                        if (s.TranscodingInfo.AudioChannels) {
                            a += ' ' + (s.TranscodingInfo.AudioChannels === 6 ? '5.1' : s.TranscodingInfo.AudioChannels + '.0');
                        }
                        cachedSessionInfo.audioCodec = a;
                    } else if (s.NowPlayingItem.MediaStreams) {
                        const vs = s.NowPlayingItem.MediaStreams.find(m => m.Type === 'Video');
                        const as = s.NowPlayingItem.MediaStreams.find(m => m.Type === 'Audio');
                        if (vs && vs.Codec) cachedSessionInfo.videoCodec = vs.Codec.toUpperCase();
                        if (as && as.Codec) {
                            let a = as.Codec.toUpperCase();
                            if (as.Channels) {
                                a += ' ' + (as.Channels === 6 ? '5.1' : as.Channels + '.0');
                            }
                            cachedSessionInfo.audioCodec = a;
                        }
                    }
                }
            }
        } catch (e) {}
    }

    function formatSpeed(bps) {
        if (bps >= 1048576) {
            return (bps / 1048576).toFixed(1) + ' MB/s';
        } else if (bps >= 1024) {
            return Math.round(bps / 1024) + ' KB/s';
        } else if (bps > 0) {
            return Math.round(bps) + ' B/s';
        }
        return '0 KB/s';
    }

    function switchDecodeMethod(mode) {
        const pm = window.playbackManager;
        const player = pm ? (pm.getCurrentPlayer ? pm.getCurrentPlayer() : (pm._currentPlayer || window.__currentVideoPlayer)) : null;

        if (mode === 'direct') {
            if (pm && pm.setMaxStreamingBitrate && player) {
                pm.setMaxStreamingBitrate({ enableAutomaticBitrateDetection: false, maxBitrate: 0 }, player);
            } else {
                const sBtn = document.querySelector('.btnVideoOsdSettings');
                if (sBtn) sBtn.click();
            }
        } else if (mode === 'transcode-1080p') {
            if (pm && pm.setMaxStreamingBitrate && player) {
                pm.setMaxStreamingBitrate({ enableAutomaticBitrateDetection: false, maxBitrate: 10000000 }, player);
            }
        } else if (mode === 'transcode-720p') {
            if (pm && pm.setMaxStreamingBitrate && player) {
                pm.setMaxStreamingBitrate({ enableAutomaticBitrateDetection: false, maxBitrate: 4000000 }, player);
            }
        } else if (mode === 'stats') {
            const sBtn = document.querySelector('.btnVideoOsdSettings');
            if (sBtn) {
                sBtn.click();
                setTimeout(() => {
                    const titles = Array.from(document.querySelectorAll('.actionSheetMenuItemTitle'));
                    const statsItem = titles.find(t => t.textContent.includes('播放数据') || t.textContent.includes('Playback Data'));
                    if (statsItem) statsItem.closest('.actionSheetMenuItem').click();
                }, 120);
            }
        }
        closeDecodeMenu();
    }

    function closeDecodeMenu() {
        const menu = document.getElementById('potplayerDecodeMenu');
        if (menu) menu.remove();
    }

    function toggleDecodeMenu(targetBtn) {
        const existing = document.getElementById('potplayerDecodeMenu');
        if (existing) {
            existing.remove();
            return;
        }

        const isHw = cachedSessionInfo.playMethod === 'DirectPlay' || cachedSessionInfo.playMethod === 'DirectStream';

        const menu = document.createElement('div');
        menu.id = 'potplayerDecodeMenu';
        menu.className = 'potplayer-menu';

        menu.innerHTML = `
            <div class="potplayer-menu-header">🎬 选择解码方案</div>
            <div class="potplayer-menu-item ${isHw ? 'active' : ''}" data-action="direct">
                <span class="potplayer-menu-icon">⚡</span>
                <div>
                    <div class="potplayer-menu-title">硬件加速直接播放 (H/W 原画)</div>
                    <div class="potplayer-menu-desc">客户端 GPU 解码 · 原始画质 · 0 服务端损耗</div>
                </div>
            </div>
            <div class="potplayer-menu-item ${!isHw ? 'active' : ''}" data-action="transcode-1080p">
                <span class="potplayer-menu-icon">🔄</span>
                <div>
                    <div class="potplayer-menu-title">服务端兼容转码 (1080P · 10M)</div>
                    <div class="potplayer-menu-desc">解决音画不同步与编码不兼容</div>
                </div>
            </div>
            <div class="potplayer-menu-item" data-action="transcode-720p">
                <span class="potplayer-menu-icon">📱</span>
                <div>
                    <div class="potplayer-menu-title">轻量省流转码 (720P · 4M)</div>
                    <div class="potplayer-menu-desc">适合弱网、移动流量或远距离访问</div>
                </div>
            </div>
            <div class="potplayer-menu-divider"></div>
            <div class="potplayer-menu-item" data-action="stats">
                <span class="potplayer-menu-icon">📊</span>
                <div>
                    <div class="potplayer-menu-title">查看完整播放与解码统计 (Stats)</div>
                    <div class="potplayer-menu-desc">码率、丢帧数、服务端与音频详情</div>
                </div>
            </div>
        `;

        menu.querySelectorAll('.potplayer-menu-item').forEach(item => {
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                const action = item.getAttribute('data-action');
                switchDecodeMethod(action);
            });
        });

        // Position menu above button
        const rect = targetBtn.getBoundingClientRect();
        menu.style.left = `${Math.max(10, rect.left - 20)}px`;
        menu.style.bottom = `${window.innerHeight - rect.top + 8}px`;

        document.body.appendChild(menu);

        // Click outside listener
        const onDocClick = (e) => {
            if (!menu.contains(e.target) && e.target !== targetBtn && !targetBtn.contains(e.target)) {
                closeDecodeMenu();
                document.removeEventListener('click', onDocClick, true);
            }
        };
        setTimeout(() => {
            document.addEventListener('click', onDocClick, true);
        }, 50);
    }

    // Main HUD injection & update loop
    function updatePotPlayerHud() {
        const osdControls = document.querySelector('.videoOsdBottom-maincontrols .buttons');
        if (!osdControls) {
            closeDecodeMenu();
            return;
        }

        let hud = document.getElementById('potplayerHud');
        if (!hud) {
            const timeText = osdControls.querySelector('.osdTimeText');
            if (!timeText) return;

            hud = document.createElement('div');
            hud.id = 'potplayerHud';
            hud.className = 'potplayer-hud';
            hud.innerHTML = `
                <button type="button" class="potplayer-badge potplayer-badge-hw" id="potplayerHwBtn" title="点击切换解码方案 (硬解直出 / 服务端转码)">
                    <span id="potplayerHwText">⚡ H/W 直出</span>
                </button>
                <span class="potplayer-badge potplayer-badge-codec" id="potplayerVideoCodec" title="当前视频编码">AVC1</span>
                <button type="button" class="potplayer-badge potplayer-badge-audio" id="potplayerAudioBtn" title="当前音频编码与声道 (点击切换音轨)">
                    <span id="potplayerAudioText">AAC 2.0</span>
                </button>
                <div class="potplayer-badge potplayer-badge-speed potplayer-speed-idle" id="potplayerSpeedBadge" title="实时网络下载吞吐速率 (夸克88VIP拉取速度)">
                    <span class="potplayer-speed-icon">⚡</span>
                    <span id="potplayerSpeedText">0 KB/s</span>
                </div>
                <div class="potplayer-badge potplayer-badge-buffer" id="potplayerBufferBadge" title="全集预读缓冲进度与提前量">
                    <span class="potplayer-buffer-icon">💾</span>
                    <span id="potplayerBufferText">缓冲 0%</span>
                </div>
            `;

            // Insert immediately after timeText
            timeText.insertAdjacentElement('afterend', hud);

            // Bind events
            const hwBtn = hud.querySelector('#potplayerHwBtn');
            if (hwBtn) {
                hwBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    toggleDecodeMenu(hwBtn);
                });
            }

            const audioBtn = hud.querySelector('#potplayerAudioBtn');
            if (audioBtn) {
                audioBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const nativeAudioBtn = document.querySelector('.btnAudio:not(.hide)');
                    if (nativeAudioBtn) {
                        nativeAudioBtn.click();
                    } else {
                        const sBtn = document.querySelector('.btnVideoOsdSettings');
                        if (sBtn) sBtn.click();
                    }
                });
            }
        }

        // 1. Calculate Realtime Network Speed
        const now = Date.now();
        const elapsed = (now - windowStartTime) / 1000;
        if (elapsed >= 0.5) {
            if (bytesInWindow > 0) {
                currentSpeedBps = bytesInWindow / elapsed;
                bytesInWindow = 0;
            } else if (now - lastChunkDownloadedTime > 1800) {
                currentSpeedBps = 0;
            }
            windowStartTime = now;
        }

        // 2. Calculate Buffer Progress
        const video = document.querySelector('video');
        let bufferPercent = 0;
        let aheadStr = '+0s';
        let isBufferFull = false;

        if (video && video.duration && !isNaN(video.duration) && video.duration > 0) {
            const ct = video.currentTime || 0;
            let forwardBuffer = 0;
            let totalBufferedEnd = 0;

            for (let i = 0; i < video.buffered.length; i++) {
                const start = video.buffered.start(i);
                const end = video.buffered.end(i);
                if (ct >= start && ct <= end) {
                    forwardBuffer = end - ct;
                }
                if (end > totalBufferedEnd) {
                    totalBufferedEnd = end;
                }
            }

            bufferPercent = Math.min(100, Math.round((totalBufferedEnd / video.duration) * 100));
            const aheadMins = Math.floor(forwardBuffer / 60);
            const aheadSecs = Math.floor(forwardBuffer % 60);
            aheadStr = aheadMins > 0 ? `+${aheadMins}m` : `+${aheadSecs}s`;
            isBufferFull = bufferPercent >= 99;
        }

        // Update Speed Display
        const speedBadge = hud.querySelector('#potplayerSpeedBadge');
        const speedText = hud.querySelector('#potplayerSpeedText');
        if (speedBadge && speedText) {
            speedBadge.className = 'potplayer-badge potplayer-badge-speed';
            if (isBufferFull && currentSpeedBps === 0) {
                speedText.textContent = '满速已就绪';
                speedBadge.classList.add('potplayer-speed-fast');
            } else {
                speedText.textContent = formatSpeed(currentSpeedBps);
                if (currentSpeedBps >= 3 * 1048576) {
                    speedBadge.classList.add('potplayer-speed-fast'); // > 3MB/s, 88VIP high-speed green
                } else if (currentSpeedBps >= 512 * 1024) {
                    speedBadge.classList.add('potplayer-speed-normal'); // 500KB - 3MB/s
                } else if (currentSpeedBps > 0) {
                    speedBadge.classList.add('potplayer-speed-slow');
                } else {
                    speedBadge.classList.add('potplayer-speed-idle');
                }
            }
        }

        // Update Buffer Display
        const bufferBadge = hud.querySelector('#potplayerBufferBadge');
        const bufferText = hud.querySelector('#potplayerBufferText');
        if (bufferBadge && bufferText) {
            if (isBufferFull) {
                bufferText.textContent = '缓冲 100% (全集已满)';
                bufferBadge.classList.add('potplayer-buffer-full');
            } else {
                bufferText.textContent = `缓冲 ${bufferPercent}% (${aheadStr})`;
                bufferBadge.classList.remove('potplayer-buffer-full');
            }
        }

        // Update Decode & Codec Badges
        fetchSessionInfo();
        const hwBtn = hud.querySelector('#potplayerHwBtn');
        const hwText = hud.querySelector('#potplayerHwText');
        const videoCodecEl = hud.querySelector('#potplayerVideoCodec');
        const audioText = hud.querySelector('#potplayerAudioText');

        const isHw = cachedSessionInfo.playMethod === 'DirectPlay' || cachedSessionInfo.playMethod === 'DirectStream';
        if (hwBtn && hwText) {
            hwBtn.className = isHw ? 'potplayer-badge potplayer-badge-hw' : 'potplayer-badge potplayer-badge-sw';
            hwText.textContent = isHw ? '⚡ H/W 直出' : '🔄 S/W 转码';
        }
        if (videoCodecEl) {
            videoCodecEl.textContent = cachedSessionInfo.videoCodec || 'AVC1';
        }
        if (audioText) {
            audioText.textContent = cachedSessionInfo.audioCodec || 'AAC 2.0';
        }
    }

    setInterval(updatePotPlayerHud, 500);

    // =========================================================================
    // 3. Persistent "最近观看" (Recently Watched) Home Section
    // =========================================================================
    function formatTimeAgo(isoString) {
        if (!isoString) return '';
        try {
            const date = new Date(isoString);
            const now = new Date();
            const diffSec = Math.floor((now - date) / 1000);
            if (diffSec < 60) return '刚刚';
            if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分钟前`;
            if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} 小时前`;
            if (diffSec < 2592000) return `${Math.floor(diffSec / 86400)} 天前`;
            return `${date.getMonth() + 1}月${date.getDate()}日`;
        } catch (e) {
            return '';
        }
    }

    function updateNativeTitles() {
        document.querySelectorAll('.sectionTitle').forEach(el => {
            const text = el.textContent.trim();
            if (text === '继续观看') {
                el.textContent = '最近观看';
            }
        });
    }

    let isUpdating = false;

    async function checkRecentSection() {
        if (isUpdating) return;
        const hash = window.location.hash || '';
        if (hash && !hash.startsWith('#/home') && hash !== '#/' && hash !== '') {
            return;
        }

        updateNativeTitles();

        // If native continue-watching section has visible cards, ensure its title is "最近观看"
        const nativeSection = document.querySelector('.section1:not(.hide)');
        if (nativeSection && nativeSection.querySelector('.card')) {
            const customSec = document.getElementById('customRecentWatchedSection');
            if (customSec) customSec.remove();
            return;
        }

        if (document.getElementById('customRecentWatchedSection')) {
            return;
        }

        if (!window.ApiClient || !window.ApiClient.getCurrentUserId) {
            return;
        }

        const userId = window.ApiClient.getCurrentUserId();
        if (!userId) return;

        isUpdating = true;
        try {
            const queryParams = {
                SortBy: 'DatePlayed',
                SortOrder: 'Descending',
                Recursive: true,
                IncludeItemTypes: 'Movie,Episode,Video',
                Limit: 12,
                fields: 'ParentId,SeriesName,PrimaryImageAspectRatio'
            };

            const result = await window.ApiClient.getItems(userId, queryParams);
            const items = (result && result.Items) ? result.Items.filter(it => it.UserData && it.UserData.LastPlayedDate) : [];

            if (!items.length) return;

            // Fetch parent names for series context
            const parentIds = [...new Set(items.map(it => it.ParentId).filter(Boolean))];
            const parentMap = {};
            if (parentIds.length && window.ApiClient.getItem) {
                await Promise.all(parentIds.map(async pid => {
                    try {
                        const p = await window.ApiClient.getItem(userId, pid);
                        if (p && p.Name) parentMap[pid] = p.Name;
                    } catch (e) {}
                }));
            }

            const homeContainer = document.querySelector('.homeSectionsContainer') || document.querySelector('.sections');
            if (!homeContainer) return;

            const myMediaSection = homeContainer.querySelector('.section0') || homeContainer.firstElementChild;

            const sectionEl = document.createElement('div');
            sectionEl.id = 'customRecentWatchedSection';
            sectionEl.className = 'verticalSection customRecentSection';
            sectionEl.style.margin = '1.2em 0 1.5em 0';

            let cardsHtml = '';
            items.forEach(it => {
                const parentName = parentMap[it.ParentId] || it.SeriesName || '';
                const timeAgo = formatTimeAgo(it.UserData.LastPlayedDate);
                const hasCover = it.ImageTags && it.ImageTags.Primary;
                const imgUrl = hasCover ? window.ApiClient.getImageUrl(it.Id, {
                    type: 'Primary',
                    fillHeight: 320,
                    fillWidth: 500,
                    quality: 90
                }) : '';

                let statusBadge = '';
                let progressPercent = 0;
                if (it.UserData.Played) {
                    statusBadge = '<span style="background: rgba(46, 125, 50, 0.85); color: #fff; padding: 2px 7px; border-radius: 4px; font-size: 11px; font-weight: 500;">已看完</span>';
                } else if (it.UserData.PlaybackPositionTicks && it.RunTimeTicks) {
                    progressPercent = Math.min(100, Math.round((it.UserData.PlaybackPositionTicks / it.RunTimeTicks) * 100));
                    statusBadge = `<span style="background: rgba(0, 164, 220, 0.85); color: #fff; padding: 2px 7px; border-radius: 4px; font-size: 11px; font-weight: 500;">看到 ${progressPercent}%</span>`;
                }

                cardsHtml += `
                    <div class="card card-hoverable" style="width: 220px; flex: 0 0 auto; margin-right: 1.2em; cursor: pointer; transition: transform 0.2s;" onmouseover="this.style.transform='scale(1.03)'" onmouseout="this.style.transform='scale(1)'" onclick="window.location.hash='#/details?id=${it.Id}'">
                        <div class="cardBox visualCardBox" style="background: #1b1c1e; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 14px rgba(0,0,0,0.45); border: 1px solid rgba(255,255,255,0.06);">
                            <div class="cardScalable" style="position: relative; width: 100%; aspect-ratio: 16/9; background: #121214;">
                                ${imgUrl ? `<div class="cardImage" style="position: absolute; inset: 0; background: url('${imgUrl}') center/cover no-repeat;"></div>` : '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#555;"><span class="material-icons" style="font-size:44px;">movie</span></div>'}
                                <div style="position: absolute; top: 6px; right: 6px;">${statusBadge}</div>
                                ${progressPercent > 0 ? `
                                    <div style="position: absolute; bottom: 0; left: 0; right: 0; height: 4px; background: rgba(255,255,255,0.15);">
                                        <div style="height: 100%; width: ${progressPercent}%; background: #00a4dc;"></div>
                                    </div>
                                ` : ''}
                            </div>
                            <div class="cardFooter" style="padding: 10px 12px 12px 12px;">
                                <div class="cardText" style="font-weight: 600; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #fff;">
                                    ${it.Name}
                                </div>
                                <div class="cardText" style="font-size: 12px; color: rgba(255,255,255,0.55); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 4px;">
                                    ${parentName ? `${parentName} · ` : ''}${timeAgo}
                                </div>
                            </div>
                        </div>
                    </div>
                `;
            });

            sectionEl.innerHTML = `
                <div style="display: flex; align-items: baseline; justify-content: space-between; padding: 0 1.5em; margin-bottom: 0.6em;">
                    <h2 class="sectionTitle sectionTitle-cards" style="margin: 0; font-size: 1.45em; font-weight: 600; color: #fff;">
                        最近观看
                    </h2>
                    <span style="font-size: 12px; color: rgba(255,255,255,0.45);">播放历史与断点续播</span>
                </div>
                <div style="display: flex; overflow-x: auto; padding: 0.4em 1.5em; scrollbar-width: thin; -webkit-overflow-scrolling: touch;">
                    ${cardsHtml}
                </div>
            `;

            if (myMediaSection && myMediaSection.nextSibling) {
                homeContainer.insertBefore(sectionEl, myMediaSection.nextSibling);
            } else {
                homeContainer.appendChild(sectionEl);
            }

        } catch (e) {
            console.error('Error in recent watched script:', e);
        } finally {
            isUpdating = false;
        }
    }

    const observer = new MutationObserver(() => {
        checkRecentSection();
    });

    observer.observe(document.body, { childList: true, subtree: true });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', checkRecentSection);
    } else {
        setTimeout(checkRecentSection, 400);
    }
    window.addEventListener('hashchange', () => {
        setTimeout(checkRecentSection, 300);
    });

})();
