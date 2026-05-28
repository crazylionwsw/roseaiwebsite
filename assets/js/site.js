// RoseAI shared site scripts
(function () {
    'use strict';

    // ===== Pricing toggle =====
    var toggle = document.getElementById('pricing-toggle');
    if (toggle) {
        var buttons = toggle.querySelectorAll('button');
        var priceNums = document.querySelectorAll('.price-num');
        buttons.forEach(function (btn) {
            btn.addEventListener('click', function () {
                buttons.forEach(function (b) { b.classList.remove('active'); });
                btn.classList.add('active');
                var period = btn.dataset.period;
                if (period === 'yearly') {
                    document.body.classList.add('yearly');
                    priceNums.forEach(function (p) { p.textContent = p.dataset.yearly; });
                } else {
                    document.body.classList.remove('yearly');
                    priceNums.forEach(function (p) { p.textContent = p.dataset.monthly; });
                }
            });
        });
    }

    // ===== Trial form submission =====
    var form = document.getElementById('trialForm');
    if (!form) return;

    var card = document.getElementById('trialFormCard');
    var submitBtn = document.getElementById('submitBtn');
    var errorBox = document.getElementById('formError');
    var ENDPOINT = 'https://formsubmit.co/ajax/touchwant@gmail.com';

    var isZh = /^zh\b/i.test(document.documentElement.lang || '');
    var strings = isZh
        ? { timeLabel: '提交时间', timeSuffix: ' (温哥华时间)', sourceLabel: '来源页面', locale: 'zh-CN' }
        : { timeLabel: 'Submitted at', timeSuffix: ' (Vancouver time)', sourceLabel: 'Source page', locale: 'en-CA' };

    form.addEventListener('submit', async function (e) {
        e.preventDefault();
        errorBox.classList.remove('show');
        if (!form.checkValidity()) { form.reportValidity(); return; }
        submitBtn.disabled = true;
        submitBtn.classList.add('loading');

        var formData = new FormData(form);
        formData.append(strings.timeLabel, new Date().toLocaleString(strings.locale, { timeZone: 'America/Vancouver' }) + strings.timeSuffix);
        formData.append(strings.sourceLabel, location.href);
        var data = {};
        formData.forEach(function (v, k) { data[k] = v; });

        try {
            var res = await fetch(ENDPOINT, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                body: JSON.stringify(data)
            });
            if (!res.ok) throw new Error('Network error: ' + res.status);
            var result = await res.json();
            if (result.success === 'false' || result.success === false) {
                throw new Error(result.message || 'Submission failed');
            }
            card.classList.add('submitted');
            setTimeout(function () { card.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, 150);
        } catch (err) {
            console.error('Form submission failed:', err);
            errorBox.classList.add('show');
            submitBtn.disabled = false;
            submitBtn.classList.remove('loading');
        }
    });
})();
