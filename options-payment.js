// חלק תשלום אופציות (options-payment.js) – מנהל תהליך רכישת אופציות עם אינטגרציית Strike/BTCPay

(function initOptionsPayment(window) {
  const STRIKE_API_KEY = 'YOUR_STRIKE_API_KEY'; // להחליף במפתח האמיתי
  const BTCPAY_SERVER_URL = 'YOUR_BTCPAY_URL'; // או להחליף ב-BTCPay Server URL
  
  let currentPackage = null;

  // חלק תשלום אופציות (options-payment.js) – פונקציית גלילה לחבילות
  window.scrollToPackages = function() {
    document.getElementById('packages').scrollIntoView({ behavior: 'smooth' });
  };

  // חלק תשלום אופציות (options-payment.js) – פונקציית גלילה להסבר
  window.scrollToExplanation = function() {
    document.getElementById('explanation').scrollIntoView({ behavior: 'smooth' });
  };

  // חלק תשלום אופציות (options-payment.js) – פתיחת מודל תשלום
  window.purchaseOption = function(packageType, amount) {
    console.log('purchaseOption called:', { packageType, amount });
    
    // בדיקת פרמטרים
    if (!packageType || !amount) {
      console.error('Missing package type or amount');
      alert('שגיאה: פרטי החבילה לא תקינים');
      return;
    }

    currentPackage = {
      type: packageType,
      amount: amount,
      timestamp: Date.now()
    };
    
    console.log('currentPackage set:', currentPackage);

    const packageNames = {
      starter: 'Starter - 5 אופציות ($50)',
      pro: 'Pro - 35 אופציות ($250)',
      enterprise: 'Enterprise - 150 אופציות ($999)'
    };

    const modal = document.getElementById('paymentModal');
    const summary = document.getElementById('paymentSummary');
    
    // בדיקת אלמנטים
    if (!modal || !summary) {
      console.error('Payment modal elements not found');
      return;
    }
    
    summary.innerHTML = `
      <div style="text-align: center;">
        <h3 style="margin-bottom: 1rem;">${packageNames[packageType]}</h3>
        <div style="font-size: 2.5rem; font-weight: 700; margin: 1rem 0;">
          <span style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); 
                       -webkit-background-clip: text; -webkit-text-fill-color: transparent;">
            $${amount}
          </span>
        </div>
        <p style="color: #a0aec0; margin-top: 0.5rem;">תשלום חד-פעמי מאובטח</p>
      </div>
    `;

    modal.hidden = false;
  };

  // חלק תשלום אופציות (options-payment.js) – סגירת מודל
  window.closePaymentModal = function() {
    const modal = document.getElementById('paymentModal');
    const content = document.getElementById('paymentContent');
    const status = document.getElementById('paymentStatus');
    
    if (modal) modal.hidden = true;
    if (content) content.innerHTML = '';
    if (status) status.innerHTML = '';
    
    // נקה את החבילה הנוכחית
    currentPackage = null;
  };

  // חלק תשלום אופציות (options-payment.js) – תשלום בכרטיס (דרך Strike)
  window.payWithCard = async function() {
    // בדיקת תקינות
    if (!currentPackage) {
      alert('אנא בחר חבילה תחילה');
      console.error('currentPackage is null');
      return;
    }

    const content = document.getElementById('paymentContent');
    const status = document.getElementById('paymentStatus');
    
    if (!content || !status) {
      console.error('Payment content or status elements not found');
      alert('שגיאת מערכת - אנא רענן את הדף');
      return;
    }
    
    status.innerHTML = '<div style="text-align: center; color: #667eea;"><i class="fa-solid fa-spinner fa-spin"></i> יוצר חשבונית...</div>';

    try {
      // דוגמא לאינטגרציה עם Strike API
      // במציאות צריך להחליף עם קריאה אמיתית ל-API
      
      const invoiceData = await createStrikeInvoice(currentPackage.amount);
      
      content.innerHTML = `
        <div style="text-align: center; padding: 2rem;">
          <h3 style="margin-bottom: 1.5rem;">השלם תשלום בכרטיס אשראי</h3>
          <div style="background: white; padding: 2rem; border-radius: 12px; margin-bottom: 1.5rem;">
            <iframe 
              src="${invoiceData.checkoutUrl}" 
              width="100%" 
              height="400" 
              frameborder="0"
              style="border-radius: 8px;"
            ></iframe>
          </div>
          <p style="color: #a0aec0; font-size: 0.9rem;">
            <i class="fa-solid fa-lock"></i> תשלום מאובטח דרך Strike
          </p>
        </div>
      `;

      status.innerHTML = '';
      
      // האזנה לאישור תשלום
      listenForPaymentConfirmation(invoiceData.invoiceId);
      
    } catch (error) {
      status.innerHTML = `
        <div style="background: rgba(255, 107, 107, 0.1); color: #ff6b6b; padding: 1rem; border-radius: 8px;">
          <i class="fa-solid fa-exclamation-triangle"></i> שגיאה: ${error.message}
        </div>
      `;
    }
  };

  // חלק תשלום אופציות (options-payment.js) – תשלום בביטקוין/Lightning
  window.payWithBitcoin = async function() {
    // בדיקת תקינות
    if (!currentPackage) {
      alert('אנא בחר חבילה תחילה');
      console.error('currentPackage is null');
      return;
    }

    const content = document.getElementById('paymentContent');
    const status = document.getElementById('paymentStatus');
    
    if (!content || !status) {
      console.error('Payment content or status elements not found');
      alert('שגיאת מערכת - אנא רענן את הדף');
      return;
    }
    
    status.innerHTML = '<div style="text-align: center; color: #667eea;"><i class="fa-solid fa-spinner fa-spin"></i> יוצר חשבונית Lightning...</div>';

    try {
      // יצירת חשבונית Lightning
      const invoice = await createLightningInvoice(currentPackage.amount);
      
      content.innerHTML = `
        <div style="text-align: center; padding: 2rem;">
          <h3 style="margin-bottom: 1.5rem;">סרוק QR לתשלום</h3>
          <div style="background: white; padding: 2rem; border-radius: 12px; display: inline-block; margin-bottom: 1.5rem;">
            <div id="qrcode"></div>
          </div>
          <div style="background: rgba(102, 126, 234, 0.1); padding: 1rem; border-radius: 8px; margin-bottom: 1rem;">
            <p style="font-size: 0.85rem; color: #a0aec0; margin-bottom: 0.5rem;">או העתק את הקישור:</p>
            <input 
              type="text" 
              value="${invoice.paymentRequest}" 
              readonly 
              onclick="this.select()"
              style="width: 100%; padding: 0.75rem; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.1); 
                     border-radius: 8px; color: white; font-family: monospace; font-size: 0.9rem;"
            />
          </div>
          <button 
            onclick="copyToClipboard('${invoice.paymentRequest}')"
            style="background: rgba(102, 126, 234, 0.2); border: 1px solid #667eea; padding: 0.75rem 1.5rem; 
                   border-radius: 8px; color: white; cursor: pointer; margin-top: 0.5rem;"
          >
            <i class="fa-solid fa-copy"></i> העתק קישור
          </button>
          <p style="color: #a0aec0; font-size: 0.85rem; margin-top: 1.5rem;">
            ניתן לשלם עם כל ארנק Lightning (Wallet of Satoshi, Alby, Strike, etc.)
          </p>
        </div>
      `;

      // יצירת QR Code
      generateQRCode(invoice.paymentRequest);
      
      status.innerHTML = '<div style="background: rgba(132, 250, 176, 0.1); color: #10b981; padding: 1rem; border-radius: 8px; text-align: center;">ממתין לתשלום...</div>';
      
      // האזנה לאישור תשלום
      listenForPaymentConfirmation(invoice.invoiceId);
      
    } catch (error) {
      status.innerHTML = `
        <div style="background: rgba(255, 107, 107, 0.1); color: #ff6b6b; padding: 1rem; border-radius: 8px;">
          <i class="fa-solid fa-exclamation-triangle"></i> שגיאה: ${error.message}
        </div>
      `;
    }
  };

  // חלק תשלום אופציות (options-payment.js) – יצירת חשבונית Strike (דוגמא)
  async function createStrikeInvoice(amount) {
    // דוגמא - להחליף עם קריאה אמיתית ל-Strike API
    // const response = await fetch('https://api.strike.me/v1/invoices', {
    //   method: 'POST',
    //   headers: {
    //     'Authorization': `Bearer ${STRIKE_API_KEY}`,
    //     'Content-Type': 'application/json'
    //   },
    //   body: JSON.stringify({
    //     amount: { amount: amount.toString(), currency: 'USD' },
    //     description: `רכישת אופציות - ${currentPackage.type}`
    //   })
    // });
    
    // בינתיים - סימולציה
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve({
          invoiceId: 'INV_' + Date.now(),
          checkoutUrl: `https://checkout.strike.me/example?amount=${amount}`,
          expiresAt: Date.now() + 3600000
        });
      }, 1000);
    });
  }

  // חלק תשלום אופציות (options-payment.js) – יצירת חשבונית Lightning
  async function createLightningInvoice(amount) {
    // דוגמא לשימוש ב-BTCPay Server API או Strike API
    // const response = await fetch(`${BTCPAY_SERVER_URL}/api/v1/invoices`, {
    //   method: 'POST',
    //   headers: {
    //     'Authorization': `token ${BTCPAY_TOKEN}`,
    //     'Content-Type': 'application/json'
    //   },
    //   body: JSON.stringify({
    //     amount: amount,
    //     currency: 'USD',
    //     orderId: `OPT_${Date.now()}`
    //   })
    // });

    // בינתיים - סימולציה
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve({
          invoiceId: 'LNBC_' + Date.now(),
          paymentRequest: 'lnbc' + amount * 100000 + 'u1p' + Math.random().toString(36).substring(2, 15),
          expiresAt: Date.now() + 3600000
        });
      }, 1000);
    });
  }

  // חלק תשלום אופציות (options-payment.js) – האזנה לאישור תשלום
  function listenForPaymentConfirmation(invoiceId) {
    // בפועל - WebSocket או polling ל-API
    // כרגע - סימולציה
    setTimeout(() => {
      const status = document.getElementById('paymentStatus');
      status.innerHTML = `
        <div style="background: rgba(16, 185, 129, 0.1); color: #10b981; padding: 1.5rem; border-radius: 12px; text-align: center;">
          <i class="fa-solid fa-circle-check" style="font-size: 3rem; margin-bottom: 1rem;"></i>
          <h3 style="margin-bottom: 0.5rem;">התשלום אושר בהצלחה!</h3>
          <p style="color: #a0aec0; margin-bottom: 1.5rem;">האופציות שלך נרשמו במערכת</p>
          <button 
            onclick="window.location.href='index.html'"
            style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); 
                   border: none; padding: 1rem 2rem; border-radius: 50px; 
                   color: white; font-weight: 600; cursor: pointer;"
          >
            <i class="fa-solid fa-home"></i> חזור לדף הראשי
          </button>
        </div>
      `;
      
      // שמירת האופציות ב-localStorage
      saveOptionsPurchase(currentPackage, invoiceId);
    }, 5000); // 5 שניות לדוגמא
  }

  // חלק תשלום אופציות (options-payment.js) – יצירת QR Code
  function generateQRCode(data) {
    // אם יש ספריית QR Code (כמו qrcode.js)
    // new QRCode(document.getElementById('qrcode'), {
    //   text: data,
    //   width: 250,
    //   height: 250
    // });
    
    // בינתיים - placeholder
    document.getElementById('qrcode').innerHTML = `
      <div style="width: 250px; height: 250px; background: #f0f0f0; 
                  display: flex; align-items: center; justify-content: center; 
                  border-radius: 8px; color: #333;">
        <div style="text-align: center;">
          <i class="fa-solid fa-qrcode" style="font-size: 4rem; margin-bottom: 1rem;"></i>
          <p style="font-size: 0.9rem;">QR Code</p>
        </div>
      </div>
    `;
  }

  // חלק תשלום אופציות (options-payment.js) – העתקה ללוח
  window.copyToClipboard = function(text) {
    navigator.clipboard.writeText(text).then(() => {
      const status = document.getElementById('paymentStatus');
      status.innerHTML = '<div style="background: rgba(16, 185, 129, 0.1); color: #10b981; padding: 1rem; border-radius: 8px; text-align: center;">הקישור הועתק ללוח!</div>';
      setTimeout(() => {
        status.innerHTML = '<div style="background: rgba(132, 250, 176, 0.1); color: #10b981; padding: 1rem; border-radius: 8px; text-align: center;">ממתין לתשלום...</div>';
      }, 2000);
    });
  };

  // חלק תשלום אופציות (options-payment.js) – שמירת רכישה
  function saveOptionsPurchase(package, invoiceId) {
    const purchases = JSON.parse(localStorage.getItem('option_purchases') || '[]');
    purchases.push({
      package: package,
      invoiceId: invoiceId,
      confirmedAt: Date.now()
    });
    localStorage.setItem('option_purchases', JSON.stringify(purchases));
  }

  // חלק תשלום אופציות (options-payment.js) – פונקציות עזר לתנאים
  window.showTerms = function() {
    alert('תנאי השימוש יוצגו כאן');
  };

  window.showPrivacy = function() {
    alert('מדיניות הפרטיות תוצג כאן');
  };

  window.showFAQ = function() {
    alert('שאלות נפוצות יוצגו כאן');
  };

})(window);
