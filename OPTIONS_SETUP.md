# 🚀 מערכת רכישת אופציות - הוראות התקנה

## 📋 קבצים שנוצרו

1. **options-landing.html** - דף נחיתה שיווקי לרכישת אופציות
2. **styles/options-landing.css** - עיצוב מודרני ואטרקטיבי
3. **options-payment.js** - לוגיקת תשלום ואינטגרציה

## 🔧 התקנה ראשונית

### שלב 1: בחר ספק תשלומים

יש לך 2 אפשרויות פשוטות:

#### **אופציה A: Strike (מומלץ - הכי פשוט!)**
```javascript
// בקובץ options-payment.js (שורה 4):
const STRIKE_API_KEY = 'YOUR_STRIKE_API_KEY';

// להרשמה:
// 1. גש ל-https://strike.me/business
// 2. צור חשבון עסקי
// 3. קבל API Key מ-Dashboard > Developers
// 4. העתק את המפתח למשתנה למעלה
```

**יתרונות Strike:**
- ✅ הקונה משלם בכרטיס אשראי רגיל
- ✅ אתה מקבל ביטקוין אוטומטית
- ✅ המרה לפיאט קלה
- ✅ אין צורך בשרת משלך

#### **אופציה B: BTCPay Server (למתקדמים)**
```javascript
// בקובץ options-payment.js (שורה 5):
const BTCPAY_SERVER_URL = 'https://your-btcpay-instance.com';

// להתקנה:
// 1. עקוב אחרי https://docs.btcpayserver.org/Deployment/
// 2. צור חנות חדשה
// 3. צור API Key
// 4. העתק את ה-URL ואת ה-Token
```

**יתרונות BTCPay:**
- ✅ שליטה מלאה
- ✅ אפס עמלות
- ✅ קוד פתוח
- ❌ דורש שרת משלך

### שלב 2: הוסף ספריית QR Code

הוסף לתחתית `options-landing.html` (לפני `</body>`):

```html
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
```

### שלב 3: חבר לדף הראשי

ב-`index.html`, עדכן את הכפתור "רכישת אופציות" (שורה 328):

```html
<!-- במקום onclick="openOptionPurchase()" -->
<button class="contract-actions__primary" type="button" onclick="window.location.href='options-landing.html'">
    <i class="fa-solid fa-handshake"></i>
    רכישת אופציות שותפות
</button>
```

## 💳 אינטגרציה עם Strike API

### קוד מלא לשימוש:

```javascript
// בקובץ options-payment.js, החלף את createStrikeInvoice():

async function createStrikeInvoice(amount) {
  const response = await fetch('https://api.strike.me/v1/invoices', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${STRIKE_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      amount: { 
        amount: amount.toString(), 
        currency: 'USD' 
      },
      description: `אופציות דיגיטליות - ${currentPackage.type}`,
      correlationId: `OPT_${Date.now()}`,
      metadata: {
        package: currentPackage.type,
        timestamp: currentPackage.timestamp
      }
    })
  });

  if (!response.ok) {
    throw new Error('Failed to create invoice');
  }

  const data = await response.json();
  
  return {
    invoiceId: data.invoiceId,
    checkoutUrl: data.checkoutUrl,
    expiresAt: data.expiresAt
  };
}
```

### Webhook לאישור תשלום:

```javascript
// צור endpoint בצד שרת (Node.js + Express דוגמא):

app.post('/webhook/strike', async (req, res) => {
  const { invoiceId, state } = req.body;
  
  if (state === 'COMPLETED') {
    // התשלום אושר!
    const invoice = await getInvoiceFromDB(invoiceId);
    
    // שמור את האופציות במסד נתונים
    await saveOptionsPurchase({
      userId: invoice.userId,
      package: invoice.package,
      amount: invoice.amount,
      status: 'confirmed'
    });
    
    // שלח אימייל/התראה ללקוח
    await sendConfirmationEmail(invoice.email);
  }
  
  res.sendStatus(200);
});
```

## 🎨 התאמה אישית

### שינוי מחירים:

ב-`options-landing.html` (שורות 120-260):
```html
<div class="price-amount">99</div>  <!-- שנה כאן -->
```

### הוספת חבילות:

העתק את ה-`<div class="package-card">` והתאם:
```html
<div class="package-card">
    <div class="package-header">
        <h3>VIP</h3>
        <div class="package-price">
            <span class="price-currency">$</span>
            <span class="price-amount">5000</span>
        </div>
        <p class="package-desc">1000 אופציות דיגיטליות</p>
    </div>
    <!-- ... -->
</div>
```

## 🔐 אבטחה חשובה!

1. **אל תחשוף API Keys בצד לקוח!**
   - העבר את הקריאות ל-API דרך שרת משלך
   - השתמש ב-environment variables

2. **אמת תשלומים בצד שרת**
   - אל תסמוך על localStorage
   - תמיד אמת עם ה-API של ספק התשלומים

3. **הצפן נתונים רגישים**
   - פרטי לקוחות
   - מספרי טרנזקציות

## 📱 בדיקה

1. פתח `options-landing.html` בדפדפן
2. לחץ "בחר חבילת אופציות"
3. בחר חבילה ולחץ "רכוש עכשיו"
4. בחר אמצעי תשלום
5. בדוק שהמודל נפתח נכון

## 🚀 עלייה לאוויר

1. העלה את כל הקבצים לשרת
2. הגדר SSL certificate (HTTPS)
3. הגדר Webhooks ב-Strike Dashboard
4. בדוק על מובייל וטאבלט
5. הפעל!

## 🆘 פתרון בעיות

**בעיה: "API Key לא עובד"**
- בדוק שהעתקת נכון
- ודא שהמפתח פעיל ב-Dashboard
- בדוק הרשאות (permissions)

**בעיה: "QR Code לא מוצג"**
- ודא שספריית qrcode.js נטענת
- בדוק ב-Console לשגיאות

**בעיה: "תשלום לא מתאשר"**
- בדוק Webhook configuration
- ודא שהשרת מקבל את הקריאות

## 📞 תמיכה

Strike API Docs: https://docs.strike.me
BTCPay Docs: https://docs.btcpayserver.org
