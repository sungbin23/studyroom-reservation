(function () {
  'use strict';

  const DATA = window.STUDYROOM_DATA;
  const KEYS = {
    reservations: 'studyroom.reservations.v1',
    cond: 'studyroom.cond.v1',
    metrics: 'studyroom.metrics.v1',
    testMode: 'studyroom.testMode.v1'
  };
  const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
  const STEPS = { cond: [1, '조건 고르기'], list: [2, '방 고르기'], done: [3, '예약 완료'] };
  // 사용자는 방을 바꾸기보다 조금 늦게 모이는 쪽을 택합니다(M08). 그래서 30분 뒤를 맨 먼저 제안합니다.
  const NEAR_OFFSETS = [30, -30, 60, -60];
  const FAR_OFFSETS = [90, -90, 120, -120];
  const MAX_ROOMS_PER_ALT = 2;
  const DIAL_SETTLE_MS = 150;
  const TARGET_SECONDS = 30;
  const TARGET_RECOVERY_SECONDS = 5;
  const SHEET_CLOSE_MS = 180;
  const TAP_GUARD_MS = 300; // 화면이 바뀐 직후의 두 번째 터치가 새 화면 버튼을 누르지 않게 막습니다.

  const $ = (selector, root) => (root || document).querySelector(selector);
  const screenEl = $('#screen');
  const modalRoot = $('#modal-root');
  const hudEl = $('#hud');
  const appEl = $('#app');
  const dockEl = $('#dock');

  /* ---------- 아이콘: 이모지나 글자 기호 대신 인라인 SVG만 씁니다 ---------- */
  const ICON_PATHS = {
    check: '<path d="M5 12.5l5 5 9-10.5"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    circleCheck: '<circle cx="12" cy="12" r="8.5"/><path d="M8 12.2l2.8 2.8L16 9.5"/>',
    minus: '<path d="M5 12h14"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5"/><path d="M16 4.8a3.5 3.5 0 0 1 0 6.4M18 14.9c1.9.8 3.1 2.5 3.5 5.1"/>',
    calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M3.5 10h17M8 2.8V7M16 2.8V7"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    timer: '<circle cx="12" cy="13.5" r="7.5"/><path d="M12 9.5v4l2.5 1.5M9.5 2.5h5"/>',
    layers: '<path d="M12 3.5l9 5-9 5-9-5z"/><path d="M3.5 13l8.5 4.7 8.5-4.7"/>',
    door: '<path d="M6 21V4.5A1.5 1.5 0 0 1 7.5 3h9A1.5 1.5 0 0 1 18 4.5V21M3.5 21h17M14.5 12v.5"/>',
    star: '<path d="M12 3.5l2.6 5.6 6 .7-4.5 4.1 1.2 6-5.3-3-5.3 3 1.2-6-4.5-4.1 6-.7z"/>',
    monitor: '<rect x="3" y="4.5" width="18" height="12" rx="2"/><path d="M8.5 20.5h7M12 16.5v4"/>',
    board: '<rect x="3.5" y="4" width="17" height="12" rx="1.5"/><path d="M8 20l2-4M16 20l-2-4M7.5 8.5h6M7.5 12h9"/>',
    plug: '<path d="M9 3v5M15 3v5M6.5 8h11v3.5a5.5 5.5 0 0 1-11 0zM12 17v4"/>',
    projector: '<rect x="2.5" y="8" width="19" height="9.5" rx="2.5"/><circle cx="15.5" cy="12.75" r="2.5"/><path d="M6 12h3M6 20v-2.5M18 20v-2.5"/>',
    video: '<rect x="2.5" y="6" width="13.5" height="12" rx="2.5"/><path d="M16 10.5l5.5-3v9l-5.5-3"/>'
  };
  const EQUIPMENT_ICONS = {
    '콘센트': 'plug',
    '모니터': 'monitor',
    '대형 모니터': 'monitor',
    '화이트보드': 'board',
    '빔프로젝터': 'projector',
    '화상회의 카메라': 'video'
  };
  const icon = (name) => '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' + ICON_PATHS[name] + '</svg>';

  /* ---------- 저장소: 사생활 보호 모드 등에서 실패해도 앱은 계속 동작해야 합니다 ---------- */
  function read(area, key, fallback) {
    try {
      const raw = window[area].getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  }
  function write(area, key, value) {
    try {
      window[area].setItem(key, JSON.stringify(value));
    } catch (e) { /* 메모리 값으로 계속 진행 */ }
  }

  /* ---------- 날짜·시간 ---------- */
  const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
  const pad = (n) => String(n).padStart(2, '0');
  const toHHMM = (min) => pad(Math.floor(min / 60)) + ':' + pad(min % 60);
  const dateKey = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const parseKey = (key) => { const [y, m, d] = key.split('-').map(Number); return new Date(y, m - 1, d); };
  const todayKey = () => dateKey(new Date());
  const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
  const fmtRange = (s, e) => toHHMM(s) + '~' + toHHMM(e);

  const OPEN = toMin(DATA.openTime);
  const CLOSE = toMin(DATA.closeTime);
  const SLOT = DATA.slotMinutes;

  function fmtShort(key) {
    const d = parseKey(key);
    return (d.getMonth() + 1) + '/' + d.getDate() + '(' + WEEKDAYS[d.getDay()] + ')';
  }

  function fmtDate(key) {
    const d = parseKey(key);
    return (d.getMonth() + 1) + '월 ' + d.getDate() + '일 (' + WEEKDAYS[d.getDay()] + ')';
  }

  function dateOptions() {
    const base = new Date();
    base.setHours(12, 0, 0, 0);
    return Array.from({ length: DATA.bookableDays }, (_, i) => {
      const d = new Date(base);
      d.setDate(base.getDate() + i);
      return dateKey(d);
    });
  }

  function startOptions(key) {
    const shortest = Math.min(...DATA.durationOptions) * 60;
    const earliest = key === todayKey() ? nowMin() : OPEN;
    const list = [];
    for (let m = OPEN; m + shortest <= CLOSE; m += SLOT) {
      if (m >= earliest) list.push(m);
    }
    return list;
  }

  /* ---------- 예약 데이터 ---------- */
  let reservations = read('localStorage', KEYS.reservations, []);
  if (!Array.isArray(reservations)) reservations = [];
  reservations = reservations.filter((r) => r && r.date >= todayKey());
  write('localStorage', KEYS.reservations, reservations);

  function busyRanges(roomId, key) {
    const fixed = DATA.fixedBookings;
    const weekday = fixed.byWeekday[parseKey(key).getDay()] || {};
    const list = (fixed.everyDay[roomId] || []).concat(weekday[roomId] || [])
      .map(([s, e]) => [toMin(s), toMin(e)]);
    reservations.forEach((r) => {
      if (r.roomId === roomId && r.date === key) list.push([r.start, r.end]);
    });
    return list;
  }

  const isRoomFree = (roomId, key, s, e) => busyRanges(roomId, key).every(([bs, be]) => e <= bs || s >= be);

  function isSlotOpen(key, s, e) {
    if (s < OPEN || e > CLOSE) return false;
    return key !== todayKey() || s >= nowMin();
  }

  function freeRooms(people, key, s, e) {
    return DATA.rooms
      .filter((room) => room.capacity >= people && isRoomFree(room.id, key, s, e))
      .sort((a, b) => a.capacity - b.capacity || a.id.localeCompare(b.id));
  }

  const findRoom = (id) => DATA.rooms.find((room) => room.id === id);
  const findReservation = (id) => reservations.find((r) => r.id === id);

  /* ---------- 조건: 화면을 오가도, 새로고침해도 유지됩니다 ---------- */
  let cond = sanitize(read('sessionStorage', KEYS.cond, {}));

  // 지금 시각 기준으로 더 이상 유효하지 않은 값은 뒤따르는 선택까지 함께 비웁니다.
  function sanitize(raw) {
    const c = { people: DATA.people.default, date: null, start: null, duration: null };
    if (!raw || typeof raw !== 'object') return c;
    if (Number.isInteger(raw.people) && raw.people >= DATA.people.min && raw.people <= DATA.people.max) c.people = raw.people;
    if (dateOptions().includes(raw.date) && startOptions(raw.date).length) c.date = raw.date;
    // 다이얼은 언제나 어떤 시간을 가리키므로, 날짜가 있으면 시작 시간도 항상 있습니다.
    if (c.date) {
      const starts = startOptions(c.date);
      c.start = starts.includes(raw.start) ? raw.start : starts[0];
    }
    if (c.start !== null && DATA.durationOptions.includes(raw.duration) && c.start + raw.duration * 60 <= CLOSE) {
      c.duration = raw.duration;
    }
    return c;
  }

  const saveCond = () => write('sessionStorage', KEYS.cond, cond);
  const isComplete = (c) => c.people !== null && c.date !== null && c.start !== null && c.duration !== null;
  const condEnd = () => cond.start + cond.duration * 60;

  /* ---------- 테스트 모드 측정 ---------- */
  const newMetrics = () => ({ startedAt: null, finishedAt: null, back: 0, rechoose: 0, recoverFrom: null, recoverMax: null });
  let metrics = Object.assign(newMetrics(), read('sessionStorage', KEYS.metrics, {}));
  let testMode = read('localStorage', KEYS.testMode, false) === true;
  let hudTimer = null;
  let failNextApproval = false;

  const saveMetrics = () => write('sessionStorage', KEYS.metrics, metrics);

  function markFirstTouch(event) {
    if (metrics.startedAt !== null || metrics.finishedAt !== null) return;
    if (event.target.closest && event.target.closest('.testbar')) return;
    metrics.startedAt = Date.now();
    saveMetrics();
    renderHud();
  }

  function countMetric(kind) {
    if (metrics.finishedAt !== null) return;
    metrics[kind] += 1;
    // 연달아 되돌리면 처음 되돌린 순간부터 복구 시간을 잽니다.
    if (metrics.recoverFrom === null) metrics.recoverFrom = Date.now();
    saveMetrics();
    renderHud();
  }

  // 되돌린 뒤 다시 앞 단계로 나아가는 순간 복구가 끝난 것으로 봅니다.
  function markRecovered() {
    if (metrics.finishedAt !== null || metrics.recoverFrom === null) return;
    const took = Date.now() - metrics.recoverFrom;
    metrics.recoverMax = metrics.recoverMax === null ? took : Math.max(metrics.recoverMax, took);
    metrics.recoverFrom = null;
    saveMetrics();
    renderHud();
  }

  function syncLayoutVars() {
    const root = document.documentElement.style;
    root.setProperty('--header-h', $('#topbar').offsetHeight + 'px');
    root.setProperty('--hud-h', (testMode ? hudEl.offsetHeight : 0) + 'px');
  }

  function renderHud() {
    hudEl.hidden = !testMode;
    document.body.classList.toggle('test-on', testMode);
    $('#test-state').textContent = testMode ? '켜짐' : '꺼짐';
    $('#test-reset').hidden = !testMode;
    const failButton = $('#test-fail');
    failButton.hidden = !testMode;
    failButton.setAttribute('aria-pressed', String(failNextApproval));
    failButton.textContent = failNextApproval ? '승인 실패 대기 중' : '승인 실패 재현';

    const running = testMode && metrics.startedAt !== null && metrics.finishedAt === null;
    if (running && !hudTimer) hudTimer = setInterval(renderHud, 100);
    if (!running && hudTimer) { clearInterval(hudTimer); hudTimer = null; }
    if (!testMode) { syncLayoutVars(); return; }

    const end = metrics.finishedAt !== null ? metrics.finishedAt : Date.now();
    const seconds = metrics.startedAt === null ? null : (end - metrics.startedAt) / 1000;
    const timeText = seconds === null ? '첫 터치를 기다려요' : seconds.toFixed(1) + '초';
    const recoverSeconds = metrics.recoverMax === null ? null : metrics.recoverMax / 1000;
    let html = '<div class="hud-row"><span class="hud-time">' + icon('timer') + timeText + '</span>' +
      '<span>뒤로가기 ' + metrics.back + '회</span><span>다시 고르기 ' + metrics.rechoose + '회</span>' +
      '<span>복구 최장 ' + (recoverSeconds === null ? '-' : recoverSeconds.toFixed(1) + '초') + '</span></div>';
    if (metrics.finishedAt !== null) {
      const undone = metrics.back + metrics.rechoose;
      const verdicts = [
        seconds <= TARGET_SECONDS ? [true, '30초 이하 달성'] : [false, '30초 초과'],
        undone === 0 ? [true, '오터치·취소 0회 달성'] : [false, '오터치·취소 ' + undone + '회'],
        recoverSeconds === null ? [true, '복구할 일 없음']
          : recoverSeconds <= TARGET_RECOVERY_SECONDS ? [true, '복구 5초 이하 달성'] : [false, '복구 5초 초과']
      ];
      html += '<div class="hud-row">' + verdicts.map(([ok, text]) => '<span>' + icon(ok ? 'check' : 'x') + text + '</span>').join('') + '</div>';
    }
    hudEl.innerHTML = html;
    syncLayoutVars();
  }

  /* ---------- 화면 이동: 팝업까지 포함해 모든 단계를 history 항목으로 둡니다 ---------- */
  let entry = null;
  let renderedBase = null;
  let lastScreenChange = 0;
  let booted = false;
  let pendingNotice = '';
  const pending = { reset: false, rechoose: false, silent: false, navigating: false };
  const scrollMemory = {};

  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

  function pushEntry(next) {
    markRecovered();
    entry = Object.assign({ idx: entry.idx + 1 }, next);
    history.pushState(entry, '');
    show(false);
  }

  function replaceEntry(next) {
    entry = Object.assign({ idx: entry.idx }, next);
    history.replaceState(entry, '');
    show(false);
  }

  function goBack(flag) {
    if (pending.navigating) return;
    pending.navigating = true;
    if (flag) pending[flag] = true;
    history.back();
  }

  function onPopState(event) {
    pending.navigating = false;
    const next = event.state || { idx: 0, screen: 'cond' };
    const wentBack = next.idx < entry.idx;

    if (pending.reset) {
      pending.reset = false;
      resetAll();
      return;
    }
    if (wentBack && !pending.silent) countMetric(pending.rechoose ? 'rechoose' : 'back');
    if (!wentBack) markRecovered();
    pending.rechoose = false;
    pending.silent = false;

    entry = next;
    show(wentBack);
  }

  function resetAll() {
    cond = sanitize({});
    saveCond();
    metrics = newMetrics();
    saveMetrics();
    renderHud();
    entry = { idx: 0, screen: 'cond' };
    history.replaceState(entry, '');
    renderedBase = null;
    show(false);
  }

  function goHome() {
    if (entry.idx === 0) { resetAll(); return; }
    pending.reset = true;
    history.go(-entry.idx);
  }

  function show(isBack) {
    const requested = entry;
    if (entry.screen === 'list' || entry.screen === 'confirm') {
      const fresh = sanitize(cond);
      if (fresh.start !== cond.start) {
        // 지금 보던 시간이 지나갔다면 몰래 바꾸지 않고 조건 화면에서 다시 확인하게 합니다.
        pendingNotice = '그 사이 시간이 지났어요. 시작 시간을 다시 확인해주세요.';
        entry = { idx: entry.idx, screen: 'cond' };
      }
      cond = fresh;
      saveCond();
    }
    if (entry.screen === 'done' && !findReservation(entry.resId)) entry = { idx: entry.idx, screen: 'cond' };
    if ((entry.screen === 'list' || entry.screen === 'confirm') && !isComplete(cond)) entry = { idx: entry.idx, screen: 'cond' };
    if (entry.screen === 'confirm' && !(entry.pick && findRoom(entry.pick.roomId))) entry = { idx: entry.idx, screen: 'list' };
    if (entry !== requested) history.replaceState(entry, '');

    const base = entry.screen === 'confirm' ? 'list' : entry.screen;
    const changed = base !== renderedBase;
    if (changed) {
      if (renderedBase) scrollMemory[renderedBase] = window.scrollY;
      renderBase(base);
      renderedBase = base;
      lastScreenChange = Date.now();
      window.scrollTo(0, isBack ? (scrollMemory[base] || 0) : 0);
      if (booted) playScreenIn();
    }
    syncModal();
    if (changed && booted && entry.screen !== 'confirm') {
      const heading = $('h1', screenEl);
      if (heading) heading.focus({ preventScroll: true });
    }
  }

  function playScreenIn() {
    screenEl.classList.remove('screen-in');
    void screenEl.offsetWidth;
    screenEl.classList.add('screen-in');
  }

  function setDock(html) {
    dockEl.innerHTML = html;
    dockEl.hidden = !html;
    document.body.classList.toggle('has-dock', Boolean(html));
  }

  function renderBase(base) {
    const [step, label] = STEPS[base];
    $('#step-count').textContent = step + '/3';
    $('#step-label').textContent = label;
    document.querySelectorAll('.progress-bar i').forEach((bar, i) => bar.classList.toggle('on', i < step));
    $('#btn-back').disabled = base === 'cond';
    setDock('');
    if (base === 'cond') renderCond();
    if (base === 'list') renderList();
    if (base === 'done') renderDone();
  }

  /* ---------- 1/3 조건 입력 ---------- */
  function option(name, value, main, sub, opts) {
    const o = opts || {};
    return '<label class="opt ' + (o.cls || '') + '">' +
      '<input type="radio" name="' + name + '" value="' + value + '"' + (o.checked ? ' checked' : '') + (o.disabled ? ' disabled' : '') + '>' +
      '<span class="opt-face"><span class="opt-check">' + icon('check') + '</span><b>' + main + '</b>' +
      (sub ? '<small>' + sub + '</small>' : '') + '</span></label>';
  }

  function secTitle(tag, iconName, id, text) {
    return '<' + tag + ' class="sec-title" id="' + id + '">' + (iconName ? icon(iconName) : '') + '<span>' + text + '</span></' + tag + '>';
  }

  function renderCond() {
    screenEl.innerHTML =
      '<h1 tabindex="-1">어떤 방을 찾고 있어요?</h1>' +
      '<section class="card field" id="sec-people">' + secTitle('h2', 'users', 'h-people', '몇 명이서 쓸 건가요?') +
        '<div class="grid grid-3" role="radiogroup" aria-labelledby="h-people">' +
        DATA.people.quick.map((n) => option('people', n, n + '명', '', { cls: 'opt-chip' })).join('') + '</div>' +
        '<div class="stepper" role="group" aria-label="인원 직접 정하기">' +
          '<button class="step-btn" type="button" data-step="-1" aria-label="한 명 줄이기">' + icon('minus') + '</button>' +
          '<output class="people-value" id="people-value" aria-live="polite"></output>' +
          '<button class="step-btn" type="button" data-step="1" aria-label="한 명 늘리기">' + icon('plus') + '</button>' +
        '</div><p class="people-hint" id="people-hint"></p></section>' +
      '<section class="card field" id="sec-date">' + secTitle('h2', 'calendar', 'h-date', '언제 쓸 건가요?') +
        '<div class="grid grid-4" role="radiogroup" aria-labelledby="h-date" id="date-options"></div></section>' +
      '<section class="card field" id="sec-time">' + secTitle('h2', 'clock', 'h-time', '몇 시부터 쓸 건가요?') +
        '<p class="dial-hint">위아래로 밀거나, 원하는 시간을 눌러주세요.</p><div id="time-options"></div>' +
        '<div class="subfield" id="sec-dur">' + secTitle('h3', '', 'h-dur', '얼마나 쓸 건가요?') +
          '<div class="grid grid-3" role="radiogroup" aria-labelledby="h-dur" id="dur-options"></div></div></section>' +
      '<p class="notice" id="notice" role="status"></p>';
    setDock('<button class="cta" id="btn-find" type="button"></button>');
    syncPeople();
    renderDateOptions();
    renderTimeOptions();
    renderDurOptions();
    syncReveal();
    centerDial();
    placeNotice(pendingNotice, cond.date ? '#sec-time' : null);
    pendingNotice = '';
  }

  function syncPeople() {
    const { min, max } = DATA.people;
    $('#people-value').textContent = cond.people + '명';
    document.querySelectorAll('input[name="people"]').forEach((chip) => {
      chip.checked = Number(chip.value) === cond.people;
    });
    const minus = $('[data-step="-1"]');
    const plus = $('[data-step="1"]');
    // 눌렀던 버튼이 비활성으로 바뀌어도 키보드 사용자의 초점을 잃지 않게 합니다.
    if (cond.people <= min && document.activeElement === minus) plus.focus();
    if (cond.people >= max && document.activeElement === plus) minus.focus();
    minus.disabled = cond.people <= min;
    plus.disabled = cond.people >= max;
    let hint = min + '명부터 ' + max + '명까지 고를 수 있어요.';
    if (cond.people <= min) hint = min + '명이 가장 적은 인원이에요.';
    if (cond.people >= max) hint = max + '명까지 예약할 수 있어요.';
    $('#people-hint').textContent = hint;
  }

  function setPeople(n) {
    cond.people = Math.max(DATA.people.min, Math.min(DATA.people.max, n));
    saveCond();
    syncPeople();
  }

  function renderDateOptions() {
    const today = todayKey();
    const options = dateOptions();
    $('#date-options').innerHTML = options.map((key, i) => {
      const d = parseKey(key);
      const closed = key === today && startOptions(key).length === 0;
      const sub = closed ? '마감' : i === 0 ? '오늘' : i === 1 ? '내일' : WEEKDAYS[d.getDay()] + '요일';
      return option('date', key, (d.getMonth() + 1) + '/' + d.getDate(), sub, { checked: cond.date === key, disabled: closed });
    }).join('');
  }

  function periodLabel(m) {
    if (m < 12 * 60) return '오전';
    return m < 18 * 60 ? '오후' : '저녁';
  }

  function renderTimeOptions() {
    const box = $('#time-options');
    if (!cond.date) { box.innerHTML = ''; return; }
    box.innerHTML = '<div class="dial" id="dial" role="radiogroup" aria-labelledby="h-time">' +
      startOptions(cond.date).map((m) => '<label class="dial-item">' +
        '<input type="radio" name="start" value="' + m + '"' + (cond.start === m ? ' checked' : '') + '>' +
        '<span class="dial-face"><small>' + periodLabel(m) + '</small><b>' + toHHMM(m) + '</b>' +
        '<span class="dial-check">' + icon('check') + '</span></span></label>').join('') + '</div>';
  }

  function dialInputs() {
    return Array.from(document.querySelectorAll('#dial input'));
  }

  function dialPitch(dial) {
    const items = dial.querySelectorAll('.dial-item');
    return items.length > 1 ? items[1].offsetTop - items[0].offsetTop : 1;
  }

  function centerDial() {
    const dial = $('#dial');
    if (!dial || dial.offsetParent === null) return;
    const index = dialInputs().findIndex((input) => Number(input.value) === cond.start);
    if (index >= 0) dial.scrollTop = index * dialPitch(dial);
  }

  function inputAtDialCenter(dial) {
    const inputs = dialInputs();
    const index = Math.round(dial.scrollTop / dialPitch(dial));
    return inputs[Math.max(0, Math.min(inputs.length - 1, index))];
  }

  let dialTimer = null;
  function onDialScroll(event) {
    const dial = event.target;
    if (dial.id !== 'dial') return;
    inputAtDialCenter(dial).checked = true;
    clearTimeout(dialTimer);
    dialTimer = setTimeout(() => {
      if (!document.body.contains(dial)) return;
      const value = Number(inputAtDialCenter(dial).value);
      if (value !== cond.start) applyStart(value);
    }, DIAL_SETTLE_MS);
  }

  function renderDurOptions() {
    const box = $('#dur-options');
    if (cond.start === null) { box.innerHTML = ''; return; }
    box.innerHTML = DATA.durationOptions.map((h) => {
      const end = cond.start + h * 60;
      const over = end > CLOSE;
      return option('duration', h, h + '시간', over ? '22시 마감' : '~' + toHHMM(end), { cls: 'opt-dur', checked: cond.duration === h, disabled: over });
    }).join('');
  }

  function syncReveal() {
    $('#sec-time').hidden = cond.date === null;
    $('#sec-dur').hidden = cond.start === null;
    const find = $('#btn-find');
    find.disabled = !isComplete(cond);
    if (cond.date === null) find.textContent = '날짜를 골라주세요';
    else if (cond.duration === null) find.textContent = '이용 시간을 골라주세요';
    else find.textContent = '빈 방 찾기';
  }

  function placeNotice(text, sectionSelector) {
    const notice = $('#notice');
    if (!notice) return;
    notice.textContent = text || '';
    if (text && sectionSelector) $(sectionSelector + ' .sec-title').after(notice);
  }

  function scrollToEl(el) {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  }

  function dropInvalidDuration() {
    if (cond.duration === null || cond.start + cond.duration * 60 <= CLOSE) return false;
    cond.duration = null;
    return true;
  }

  function applyStart(value) {
    cond.start = value;
    const dropped = dropInvalidDuration();
    renderDurOptions();
    saveCond();
    syncReveal();
    placeNotice(dropped ? '22시까지만 쓸 수 있어서 이용 시간을 다시 골라주세요.' : '', '#sec-dur');
  }

  function applyDate(key) {
    cond.date = key;
    const starts = startOptions(key);
    let notice = '';
    if (!starts.includes(cond.start)) {
      if (cond.start !== null) notice = '오늘은 이미 지난 시간이라 시작 시간을 다시 맞춰뒀어요. 확인해주세요.';
      cond.start = starts[0];
      dropInvalidDuration();
    }
    renderTimeOptions();
    renderDurOptions();
    saveCond();
    syncReveal();
    centerDial();
    placeNotice(notice, '#sec-time');
  }

  function onCondChange(event) {
    const input = event.target;
    if (!input.matches('input[type="radio"]')) return;

    if (input.name === 'people') setPeople(Number(input.value));
    if (input.name === 'date') {
      const firstTime = cond.date === null;
      applyDate(input.value);
      if (firstTime) scrollToEl($('#sec-time'));
    }
    if (input.name === 'start') {
      applyStart(Number(input.value));
      centerDial();
    }
    if (input.name === 'duration') {
      cond.duration = Number(input.value);
      saveCond();
      syncReveal();
    }
  }

  function onFind() {
    const before = cond;
    cond = sanitize(cond);
    saveCond();
    if (!isComplete(cond) || cond.start !== before.start) {
      pendingNotice = '그 사이 시간이 지났어요. 시작 시간을 다시 골라주세요.';
      renderedBase = null;
      show(false);
      return;
    }
    pushEntry({ screen: 'list' });
  }

  /* ---------- 2/3 빈 방 리스트 ---------- */
  function summaryHtml() {
    return '<p class="summary">' + icon('users') + '<span>' + cond.people + '명 · ' + fmtShort(cond.date) + ' · ' +
      fmtRange(cond.start, condEnd()) + '</span></p>';
  }

  function bookButton(room, s, e) {
    return '<button class="cta" type="button" data-book="' + room.id + '" data-start="' + s + '" data-end="' + e + '">예약하기' +
      '<span class="sr-only"> ' + room.id + '호 ' + fmtRange(s, e) + '</span></button>';
  }

  function roomCard(room, s, e, isTop) {
    return '<li class="room-card">' + (isTop ? '<p class="top-pick">' + icon('star') + '인원에 가장 잘 맞는 방</p>' : '') +
      '<div class="room-head"><div><p class="room-no">' + room.id + '호</p>' +
      '<p class="room-meta">' + icon('layers') + room.floor + '층</p></div>' +
      '<p class="room-cap">' + room.capacity + '인실</p></div>' +
      '<p class="status-free">' + icon('circleCheck') + '비어 있어요</p>' +
      '<ul class="badges" aria-label="장비">' + room.equipment.map((name) => '<li>' + icon(EQUIPMENT_ICONS[name] || 'plug') + name + '</li>').join('') + '</ul>' +
      bookButton(room, s, e) + '</li>';
  }

  const EMPTY_ART = '<svg class="empty-art" viewBox="0 0 200 130" aria-hidden="true" focusable="false">' +
    '<ellipse class="a-floor" cx="100" cy="120" rx="82" ry="8"/>' +
    '<rect class="a-frame" x="52" y="10" width="90" height="110" rx="10"/>' +
    '<rect class="a-door" x="64" y="22" width="66" height="98" rx="5"/>' +
    '<circle class="a-knob" cx="119" cy="74" r="4.5"/>' +
    '<rect class="a-sign" x="77" y="36" width="40" height="22" rx="5"/>' +
    '<path class="a-sign-line" d="M89 47h16"/>' +
    '<circle class="a-clock" cx="152" cy="40" r="25"/>' +
    '<path class="a-hands" d="M152 26v14l9 6"/></svg>';

  function renderList() {
    const s = cond.start;
    const e = condEnd();
    const rooms = freeRooms(cond.people, cond.date, s, e);
    const notice = pendingNotice ? '<p class="notice" role="status">' + pendingNotice + '</p>' : '';
    pendingNotice = '';

    if (rooms.length) {
      screenEl.innerHTML = '<h1 tabindex="-1">빈 방 ' + rooms.length + '개를 찾았어요</h1>' +
        '<p class="lead">지금 바로 예약할 수 있는 방만 모았어요.</p>' + summaryHtml() + notice +
        '<ul class="room-list">' + rooms.map((room, i) => roomCard(room, s, e, i === 0)).join('') + '</ul>' +
        '<button class="btn-secondary change-cond" type="button" data-action="change">조건 바꾸기</button>';
      return;
    }
    screenEl.innerHTML = '<div class="empty-head">' + EMPTY_ART + '<h1 tabindex="-1">이 시간엔 빈 방이 없어요</h1>' +
      '<p class="lead">같은 인원으로 가까운 시간대를 찾아봤어요.</p>' + summaryHtml() + '</div>' + notice + alternativesHtml(s, e) +
      '<button class="btn-secondary change-cond" type="button" data-action="change">조건 바꾸기</button>';
  }

  function offsetLabel(offset) {
    const abs = Math.abs(offset);
    const h = Math.floor(abs / 60);
    const m = abs % 60;
    return (h ? h + '시간' : '') + (h && m ? ' ' : '') + (m ? m + '분' : '') + (offset < 0 ? ' 전' : ' 후');
  }

  function alternativesFor(offsets, s, e) {
    return offsets
      .filter((offset) => isSlotOpen(cond.date, s + offset, e + offset))
      .map((offset) => ({
        offset,
        s: s + offset,
        e: e + offset,
        rooms: freeRooms(cond.people, cond.date, s + offset, e + offset).slice(0, MAX_ROOMS_PER_ALT)
      }));
  }

  function alternativesHtml(s, e) {
    let alts = alternativesFor(NEAR_OFFSETS, s, e);
    if (!alts.some((alt) => alt.rooms.length)) {
      const far = alternativesFor(FAR_OFFSETS, s, e).filter((alt) => alt.rooms.length);
      alts = alts.concat(far);
    }
    if (!alts.some((alt) => alt.rooms.length)) {
      return '<div class="alts"><p class="none-at-all">가까운 시간대도 모두 꽉 찼어요. 다른 날짜나 인원으로 찾아볼까요?</p></div>';
    }
    const items = alts.map((alt) => {
      const tag = '<span class="alt-tag">' + offsetLabel(alt.offset) + '</span>';
      if (!alt.rooms.length) {
        return '<p class="alt-none">' + icon('x') + '<span>' + offsetLabel(alt.offset) + ' ' + fmtRange(alt.s, alt.e) + '</span><span>여기도 꽉 찼어요</span></p>';
      }
      return '<section class="alt"><h3>' + tag + fmtRange(alt.s, alt.e) + '</h3><ul class="room-list">' +
        alt.rooms.map((room) => roomCard(room, alt.s, alt.e)).join('') + '</ul></section>';
    }).join('');
    return '<div class="alts"><h2>이 시간은 어때요?</h2>' + items + '</div>';
  }

  /* ---------- 확인 팝업 ---------- */
  let sheetCloseTimer = null;
  function syncModal() {
    const open = entry.screen === 'confirm';
    if (!open) {
      if (!modalRoot.hidden && !modalRoot.classList.contains('closing')) {
        appEl.inert = false;
        document.body.classList.remove('modal-open');
        lastScreenChange = Date.now();
        modalRoot.classList.add('closing');
        const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        sheetCloseTimer = setTimeout(() => {
          modalRoot.hidden = true;
          modalRoot.innerHTML = '';
          modalRoot.classList.remove('closing');
        }, reduce ? 0 : SHEET_CLOSE_MS);
      }
      return;
    }
    clearTimeout(sheetCloseTimer);
    modalRoot.classList.remove('closing');
    const { roomId, start, end } = entry.pick;
    const room = findRoom(roomId);
    const row = (iconName, label, value, big) => '<div><dt>' + icon(iconName) + label + '</dt><dd' + (big ? ' class="big"' : '') + '>' + value + '</dd></div>';
    modalRoot.innerHTML = '<div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">' +
      '<div class="sheet-handle" aria-hidden="true"></div>' +
      '<h2 id="modal-title" tabindex="-1">이대로 예약할까요?</h2>' +
      '<dl class="confirm-list">' +
      row('door', '방', room.id + '호<small>' + room.floor + '층 · ' + room.capacity + '인실</small>', true) +
      row('calendar', '날짜', fmtDate(cond.date)) +
      row('clock', '시간', fmtRange(start, end)) +
      row('users', '인원', cond.people + '명') +
      '</dl><p class="notice" id="modal-error" role="alert"></p><div class="modal-actions">' +
      '<button class="cta" type="button" data-action="confirm">확인</button>' +
      '<button class="btn-secondary" type="button" data-action="repick">다시 고르기</button>' +
      '</div></div>';
    modalRoot.hidden = false;
    appEl.inert = true;
    document.body.classList.add('modal-open');
    lastScreenChange = Date.now();
    $('#modal-title').focus({ preventScroll: true });
  }

  function confirmBooking() {
    const { roomId, start, end } = entry.pick;
    if (!isSlotOpen(cond.date, start, end) || !isRoomFree(roomId, cond.date, start, end)) {
      pendingNotice = '앗, 그 사이에 예약이 어려워졌어요. 다른 방을 골라주세요.';
      renderedBase = null;
      goBack('silent');
      return;
    }
    if (!navigator.onLine || failNextApproval) {
      // HTA 3의 예외: 승인에 실패해도 고른 내용을 잃지 않고 그 자리에서 다시 시도합니다.
      failNextApproval = false;
      renderHud();
      $('#modal-error').textContent = '네트워크가 불안정해서 예약을 확정하지 못했어요. 고른 내용은 그대로 있으니 다시 눌러주세요.';
      $('[data-action="confirm"]', modalRoot).textContent = '다시 시도';
      return;
    }
    const reservation = {
      id: 'SR-' + roomId + '-' + cond.date.replace(/-/g, '') + '-' + toHHMM(start).replace(':', ''),
      roomId,
      date: cond.date,
      start,
      end,
      people: cond.people,
      createdAt: new Date().toISOString()
    };
    reservations.push(reservation);
    write('localStorage', KEYS.reservations, reservations);

    markRecovered();
    if (metrics.finishedAt === null) {
      const finishedAt = Date.now();
      metrics.startedAt = metrics.startedAt === null ? finishedAt : metrics.startedAt;
      metrics.finishedAt = finishedAt;
      saveMetrics();
      renderHud();
    }
    // 팝업 항목을 완료 화면으로 바꿔서, 뒤로가기하면 이미 끝난 팝업이 아닌 방 리스트로 갑니다.
    replaceEntry({ screen: 'done', resId: reservation.id });
  }

  /* ---------- 3/3 완료 ---------- */
  function renderDone() {
    const r = findReservation(entry.resId);
    const room = findRoom(r.roomId);
    const info = (iconName, label, value, big) => '<div><dt>' + icon(iconName) + '<span class="sr-only">' + label + '</span></dt><dd' + (big ? ' class="big"' : '') + '>' + value + '</dd></div>';
    screenEl.innerHTML = '<article class="ticket"><div class="ticket-top">' +
      '<h1 tabindex="-1">' + icon('circleCheck') + '예약이 끝났어요!</h1>' +
      '<p class="lead">스터디룸 입구에서 이 QR을 보여주세요.</p>' +
      '<div class="qr-box" id="qr" role="img" aria-label="출입용 QR코드, 예약 번호 ' + r.id + '"></div>' +
      '<p class="code">예약 번호 ' + r.id + '</p></div>' +
      '<div class="ticket-cut" aria-hidden="true"><i></i><i></i></div>' +
      '<dl class="ticket-info">' +
      info('door', '방 번호', room.id + '호 · ' + room.floor + '층', true) +
      info('users', '인원', r.people + '명', true) +
      info('calendar', '날짜', fmtShort(r.date)) +
      info('clock', '시간', fmtRange(r.start, r.end)) +
      '</dl></article>';
    setDock('<button class="cta" type="button" data-action="home">처음으로</button>');
    drawQr(r);
  }

  function drawQr(r) {
    const box = $('#qr');
    if (!box) return;
    if (window.QRCode) {
      box.innerHTML = '';
      new window.QRCode(box, {
        text: 'STUDYROOM|' + r.id + '|' + r.people,
        width: 512,
        height: 512,
        colorDark: '#000000',
        colorLight: '#ffffff',
        correctLevel: window.QRCode.CorrectLevel.M
      });
      box.removeAttribute('title');
    } else if (window.qrFailed) {
      box.innerHTML = '<p class="qr-fallback">QR코드를 불러오지 못했어요. 입구에서 아래 예약 번호를 보여주세요.</p>';
    } else {
      box.innerHTML = '<p class="qr-fallback">QR코드를 준비하고 있어요...</p>';
    }
  }

  function redrawQrIfWaiting() {
    if (renderedBase === 'done') drawQr(findReservation(entry.resId));
  }

  /* ---------- 입력 연결 ---------- */
  function onScreenClick(event) {
    const book = event.target.closest('[data-book]');
    if (book) {
      pushEntry({
        screen: 'confirm',
        pick: { roomId: book.dataset.book, start: Number(book.dataset.start), end: Number(book.dataset.end) }
      });
      return;
    }
    const stepper = event.target.closest('[data-step]');
    if (stepper) {
      setPeople(cond.people + Number(stepper.dataset.step));
      return;
    }
    const action = event.target.closest('[data-action]');
    if (action && action.dataset.action === 'change') goBack();
    if (action && action.dataset.action === 'home') goHome();
    if (event.target.closest('#btn-find')) onFind();
  }

  function onModalClick(event) {
    const action = event.target.closest('[data-action]');
    if (!action) return;
    if (action.dataset.action === 'confirm') confirmBooking();
    if (action.dataset.action === 'repick') goBack('rechoose');
  }

  function guardTap(event) {
    if (event.target.closest('.testbar')) return;
    if (Date.now() - lastScreenChange < TAP_GUARD_MS) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  function init() {
    if (history.state && typeof history.state.idx === 'number') {
      entry = history.state;
    } else {
      entry = { idx: 0, screen: 'cond' };
      history.replaceState(entry, '');
    }

    document.addEventListener('click', guardTap, true);
    document.addEventListener('pointerdown', markFirstTouch, true);
    document.addEventListener('keydown', markFirstTouch, true);
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && entry.screen === 'confirm') goBack();
    });
    window.addEventListener('popstate', onPopState);
    window.addEventListener('resize', syncLayoutVars);
    window.addEventListener('qr-ready', redrawQrIfWaiting);
    window.addEventListener('qr-failed', redrawQrIfWaiting);

    $('#btn-back').addEventListener('click', () => goBack());
    screenEl.addEventListener('click', onScreenClick);
    dockEl.addEventListener('click', onScreenClick);
    screenEl.addEventListener('change', onCondChange);
    screenEl.addEventListener('scroll', onDialScroll, true);
    modalRoot.addEventListener('click', onModalClick);

    const toggle = $('#test-toggle');
    toggle.checked = testMode;
    toggle.addEventListener('change', () => {
      testMode = toggle.checked;
      write('localStorage', KEYS.testMode, testMode);
      renderHud();
    });
    $('#test-reset').addEventListener('click', () => {
      metrics = newMetrics();
      saveMetrics();
      renderHud();
    });

    $('#test-fail').addEventListener('click', () => {
      failNextApproval = !failNextApproval;
      renderHud();
    });

    renderHud();
    show(false);
    booted = true;
    lastScreenChange = 0;
  }

  init();
})();
