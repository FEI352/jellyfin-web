// Jellyfin Custom Enhancement:
// 1. PotPlayer-Style Aggressive Full-Episode Buffering Engine (7200s, 2GB Buffer)
// 2. Persistent "最近观看" (Recently Watched) Section with Playback Progress & History

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
            return new OriginalHls(userConfig);
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

            // Monitor buffer progress
            video.addEventListener('progress', () => {
                if (video.buffered && video.buffered.length > 0 && video.duration) {
                    const bufferedEnd = video.buffered.end(video.buffered.length - 1);
                    const percent = Math.min(100, Math.round((bufferedEnd / video.duration) * 100));
                    const bufferedMins = (bufferedEnd / 60).toFixed(1);
                    const totalMins = (video.duration / 60).toFixed(1);
                    console.debug(`[PotPlayer-Buffer] 缓冲进度: ${percent}% (${bufferedMins} / ${totalMins} 分钟)`);
                }
            });
        }
    }, true);

    // =========================================================================
    // 2. Persistent "最近观看" (Recently Watched) Home Section
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
