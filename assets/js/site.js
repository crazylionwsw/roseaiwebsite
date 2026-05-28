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

    // ===== Trial form submission (Resend) =====
    var form = document.getElementById('trialForm');
    if (!form) return;

    var card = document.getElementById('trialFormCard');
    var submitBtn = document.getElementById('submitBtn');
    var errorBox = document.getElementById('formError');

    // Configuration
    var ENDPOINT = '/api/contact';
    var RECIPIENT = 'touchwant@gmail.com';
    var FROM = 'RoseAI <noreply@roseai.ca>';

    var isZh = /^zh\b/i.test(document.documentElement.lang || '');
    var strings = isZh
        ? { timeLabel: '提交时间', timeSuffix: ' (温哥华时间)', sourceLabel: '来源页面', locale: 'zh-CN' }
        : { timeLabel: 'Submitted at', timeSuffix: ' (Vancouver time)', sourceLabel: 'Source page', locale: 'en-CA' };

    function buildEmailHtml(data, lang) {
        var isChinese = lang === 'zh';
        var submittedAt = data[strings.timeLabel] || '';
        var sourcePage = data[strings.sourceLabel] || '';

        // Map form field values to display labels
        var fields;
        if (isChinese) {
            fields = [
                { label: '称呼', value: data['姓名'] || '' },
                { label: '餐厅名称', value: data['餐厅名称'] || '' },
                { label: '联系电话', value: data['联系电话'] || '' },
                { label: '邮箱', value: data['邮箱'] || '' },
                { label: '所在区域', value: data['所在区域'] || '' },
                { label: '餐厅规模', value: data['餐厅规模'] || '' },
                { label: '备注', value: data['备注'] || '' }
            ];
        } else {
            fields = [
                { label: 'Name', value: data['Name'] || '' },
                { label: 'Restaurant', value: data['Restaurant'] || '' },
                { label: 'Phone', value: data['Phone'] || '' },
                { label: 'Email', value: data['Email'] || '' },
                { label: 'City / Region', value: data['City'] || '' },
                { label: 'Restaurant Size', value: data['Size'] || '' },
                { label: 'Notes', value: data['Notes'] || '' }
            ];
        }

        var rows = fields.map(function (f) {
            return (
                '<tr>' +
                '<td style="padding:12px 16px;border-bottom:1px solid #e8f5e9;color:#4a6b53;font-weight:600;white-space:nowrap;vertical-align:top">' + f.label + '</td>' +
                '<td style="padding:12px 16px;border-bottom:1px solid #e8f5e9;color:#1a3d2c">' + (f.value || '<span style="color:#999">—</span>') + '</td>' +
                '</tr>'
            );
        }).join('');

        var heading = isChinese ? '新试用申请' : 'New Trial Request';
        var footerNote = isChinese
            ? '此邮件由 RoseAI 官网自动发送'
            : 'This email was sent automatically from the RoseAI website';

        return (
            '<!DOCTYPE html><html><head><meta charset="utf-8"></head>' +
            '<body style="margin:0;padding:0;background:#f5f5f0;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif">' +
            '<table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:40px auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08)">' +
            // Header
            '<tr><td style="background:#09251A;padding:28px 32px">' +
            '<span style="font-family:Georgia,serif;font-size:24px;font-weight:700;color:#0d9647">Rose<span style="color:#E8241B">AI</span></span>' +
            '<span style="display:inline-block;background:rgba(13,150,71,0.2);color:#0d9647;padding:4px 12px;border-radius:20px;font-size:12px;font-weight:600;margin-left:14px">' + heading + '</span>' +
            '</td></tr>' +
            // Body
            '<tr><td style="padding:32px">' +
            '<table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e8f5e9;border-radius:8px;overflow:hidden">' +
            rows +
            '</table>' +
            // Metadata
            '<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:20px">' +
            '<tr><td style="padding:8px 0;font-size:12px;color:#999">' +
            (isChinese ? '提交时间' : 'Submitted at') + ': ' + submittedAt +
            '</td></tr>' +
            '<tr><td style="padding:4px 0;font-size:12px;color:#999">' +
            (isChinese ? '来源页面' : 'Source page') + ': ' + sourcePage +
            '</td></tr>' +
            '</table>' +
            '</td></tr>' +
            // Footer
            '<tr><td style="background:#fafaf8;padding:20px 32px;border-top:1px solid #eee;text-align:center;font-size:11px;color:#bbb">' +
            footerNote +
            '</td></tr>' +
            '</table></body></html>'
        );
    }

    form.addEventListener('submit', async function (e) {
        e.preventDefault();
        errorBox.classList.remove('show');

        // Honeypot check
        var honey = form.querySelector('[name="_honey"]');
        if (honey && honey.value) return;

        if (!form.checkValidity()) { form.reportValidity(); return; }
        submitBtn.disabled = true;
        submitBtn.classList.add('loading');

        var formData = new FormData(form);
        formData.append(strings.timeLabel, new Date().toLocaleString(strings.locale, { timeZone: 'America/Vancouver' }) + strings.timeSuffix);
        formData.append(strings.sourceLabel, location.href);

        // Collect form data
        var data = {};
        formData.forEach(function (v, k) { data[k] = v; });

        // Build email subject
        var restaurantName = data['Restaurant'] || data['餐厅名称'] || 'Unknown';
        var subject = isZh
            ? '🌹 新试用申请 · ' + restaurantName
            : '🌹 New Trial Request · ' + restaurantName;

        try {
            var res = await fetch(ENDPOINT, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    from: FROM,
                    to: [RECIPIENT],
                    subject: subject,
                    html: buildEmailHtml(data, isZh ? 'zh' : 'en')
                })
            });

            if (!res.ok) {
                var errBody = await res.text();
                throw new Error('API error ' + res.status + ': ' + errBody);
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
