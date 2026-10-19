# Vyapar App Desktop: Complete Blueprint, Software Architecture, System Logic & Step-by-Step UI Navigation Guide

Is dastaavez mein **Vyapar App Desktop** ke complete software architecture, core logic modules, database design, accounting equations, aur **sabse detailed screen-by-screen, button-by-button UI navigation flow** ki poori jaankari di gayi hai.

---

## 1. Executive Summary & System Architecture

Vyapar App Desktop ek **offline-first, GST-compliant billing, inventory, aur accounting desktop application** hai jo MSME (Micro, Small & Medium Enterprises), wholesalers, distributors, retailers aur service providers ke liye design kiya gaya hai.

```
                    +------------------------------------------+
                    |           VYAPAR DESKTOP ENGINE          |
                    +------------------------------------------+
                                         |
     +-------------------+---------------+---------------+-------------------+
     |                   |               |               |                   |
+----+----+         +----+----+     +----+----+     +----+----+         +----+----+
| Company |         |  Party  |     |Item/Stock|    |Transaction|       |Banking  |
| Master  |         | CRM/SRM |     | Engine  |     | Engine  |         | & Cash  |
+---------+         +---------+     +---------+     +---------+         +---------+
     |                   |               |               |                   |
     +-------------------+---------------+---------------+-------------------+
                                         |
                       +-----------------+-----------------+
                       |                                   |
              +--------+--------+                 +--------+--------+
              | Local SQLite DB |                 | Reports & P&L   |
              | (Offline First) |                 | Analytics Engine|
              +-----------------+                 +-----------------+
```

### Architectural Pillars (Product Building Perspective)
1. **Offline-First Storage Engine**: User ka sara financial data, inventory stock aur transactions unke local desktop computer par (encrypted SQLite / local storage) store hote hain. Daily billing, stock management aur invoice printing 100% offline aur fast chalti hai.
2. **Optional Cloud Relay & Hybrid Backup**: License authentication, optional multi-device desktop-to-mobile encrypted cloud sync, WhatsApp automated messaging APIs, aur automated Google Drive / Cloud backup support karta hai.
3. **Multi-Firm / Multi-Company Engine**: Ek single mobile login account ke andar user multiple independent business firms / companies create, switch aur isolated manage kar sakta hai.
4. **Abstracted Double-Entry Ledger**: Back-end par strict double-entry ledger bookkeeping (Debits & Credits) maintain hoti hai, par front-end par user-friendly "You Will Receive", "You Will Pay", "Cash in Hand", aur "Bank Balances" ke roop mein intuitive UI render hoti hai.

---

## 2. Detailed Module Specifications & Core Logic

### Module 1: Company Master & Profile Setup
- **Data Attributes**: Business Name, Mobile Number, Email, Address, Pincode, State (Place of Supply), Country, GSTIN, Business Type (Retail, Wholesale, Distributor, Service), Business Category, Shop Logo Image, Authorized Signature Image, Default Terms & Conditions text.
- **Invoicing Bank Details**: Account Display Name, Bank Name, Account Number, IFSC Code, Branch, UPI ID (dynamic QR Code printing ke liye).

### Module 2: Party Master (CRM & SRM Engine)
- **Entities**: Customers (Buyers) & Suppliers (Vendors).
- **Party Attributes**:
  - **Basic Profile**: Name, Phone Number, Email, Billing Address, Shipping Address, State/Location.
  - **Tax Profile**: GST Type (Unregistered, Registered Regular, Composition, Consumer), GSTIN, PAN.
  - **Financial Profile**: Opening Balance (Receivable or Payable), Credit Limit Amount & Credit Period (Days), Party Grouping.
  - **Party-wise Custom Price List Logic**: Software har party ke sath last negotiated item rate ko automatically memorize kar leta hai. Jab agli baar us party ka bill banta hai, toh default item price ki jagah us party ka custom saved price auto-fill ho jata hai.
  - **Ledger Balances**:
    - **You Will Receive**: Customer se lene wale total dues (Accounts Receivable).
    - **You Will Pay**: Supplier ko dene wale total dues (Accounts Payable).

### Module 3: Inventory & Item Master Engine
- **Item Types**:
  - `Product`: Physical goods subject to inventory quantity tracking.
  - `Service`: Intangible service offerings (Repair, Consultancy) without physical stock deductions.
- **Dual Unit & Unit Conversion Engine**:
  - Base Unit (e.g. PCS, KG, BOX) aur Secondary Unit (e.g. DOZEN, GRAM, PACKET).
  - Conversion Rules: $1 \text{ BOX} = 24 \text{ PCS}$, $1 \text{ DAY} = 24 \text{ HOURS}$.
- **Item Categorization & Attributes**:
  - Item Name, Item Code / Barcode, Category (e.g., Keyboards, FMCG), Brand.
  - HSN/SAC Code, GST Tax Rate (Exempt, 0%, 5%, 12%, 18%, 28%, Cess).
  - Pricing: Purchase Price, Sale Price, MRP (Tax Inclusive vs Tax Exclusive option).
  - Stock Settings: Opening Stock Quantity, Minimum Low-Stock Alert Threshold, Rack/Storage Location.
- **Advanced Inventory Tracking**:
  - **Batch & Expiry Management**: Batch Number, Manufacturing Date, Expiry Date. Software automated Expiring Stock Alerts render karta hai.
  - **Serial Number / IMEI Tracking**: Har individual unit ke liye unique serial number or IMEI number tracking (Electronics/Mobiles ke liye).
  - **Variant Matrix**: Size, Color, MRP variations (Garments/Footwear ke liye).
  - **Barcode Generator & Scanner Integration**: Checkout screen par fast POS scanning aur custom barcode sticker printing support.

### Module 4: Transaction Engine & Document Lifecycle
Vyapar ka transaction engine complete document lifecycle support karta hai:

#### A. Sales Lifecycle Flow
$$\text{Estimate / Quotation} \longrightarrow \text{Sales Order} \longrightarrow \text{Delivery Challan} \longrightarrow \text{Sales Invoice (Tax Invoice)} \longrightarrow \text{Payment In}$$
- **Auto-Conversion Logic**: Single-click conversion from Estimate to Sales Order, Order to Delivery Challan, Delivery Challan to Sales Invoice. Final stock deduction Sales Invoice ya Delivery Challan level par trigger hoti hai.
- **Sales Return / Credit Note**: Jab customer goods return karta hai, tab inventory stock wapas badhta hai (+ Stock), aur customer account credit hota hai.

#### B. Purchase Lifecycle Flow
$$\text{Purchase Order} \longrightarrow \text{Purchase Invoice} \longrightarrow \text{Purchase Return (Debit Note)} \longrightarrow \text{Payment Out}$$
- **ITC Tracking**: Input Tax Credit eligibility (Eligible vs Ineligible ITC) record ki jaati hai.
- **Purchase Bill Number**: Supplier ke original physical bill number ko system mein link karke store kiya jata hai.

#### C. Billing & Invoicing Logic
- **Invoice Numbering Engine**: Auto-incrementing numeric series with customizable prefixes (e.g., `INV-2026-001`).
- **Discounts**: Item-wise Discount (%) & Amount + Transaction-level Total Discount.
- **Tax Calculation Engine**:
  - Intra-State Sales (Same State): CGST + SGST (50% - 50% split of GST rate).
  - Inter-State Sales (Different State): IGST (Full GST rate).
- **Line Item Charges**: Shipping/Freight charges, Packaging, Round-off adjustments.
- **Payment Types**: Cash, Bank Account, Check (Post-Dated Check with deposit lifecycle), UPI/QR Code, Credit / Partial Payment.
- **Payment Linkage (Bill-by-Bill Settlement)**: Customer payment ko kisi specific pending invoice ke sath link karna (Invoice Matching) ya FIFO (First-In, First-Out) auto-adjustment.

### Module 5: Liquidity, Expense & Banking Engine
- **Cash in Hand Engine**: Initial business capital injection, cash adjustments, daily cash balance ledger.
- **Bank Account Engine**: Multi-bank account setup, online payment QR display on bills, bank statement reconciliation.
- **Contra Entry (Cash/Bank Transfer)**: Cash-to-Bank Deposit aur Bank-to-Cash Withdrawal entries.
- **Loan Account & EMI Management**:
  - Principal Amount, Interest Rate, Processing Fee tracking.
  - EMI Payment Split: Principal deduction (reduces Loan Liability) + Interest/Processing Fee allocation (recorded as Expense in P&L).
- **Expense Module**: Direct Expenses (Freight, Raw Material Transport) & Indirect Expenses (Rent, Salary, Tea/Tiffin, Electricity).

---

## 3. Financial Statements & Accounting Equations

### A. Mathematical Logic Matrix

| Transaction Type | Inventory Impact | Cash/Bank Impact | Party Balance Impact | Financial Statement Impact |
| :--- | :--- | :--- | :--- | :--- |
| **Purchase Invoice** | $+ \text{Stock Quantity}$ | $- \text{Paid Amount}$ | $+ \text{Payable Balance}$ | Increases Stock Asset, Increases Payable Liability |
| **Sales Invoice** | $- \text{Stock Quantity}$ | $+ \text{Received Amount}$ | $+ \text{Receivable Balance}$ | Increases Sales Revenue, Increases Cash/Receivables Asset |
| **Payment Out** | No Impact | $- \text{Cash/Bank}$ | $- \text{Payable Balance}$ | Decreases Bank Asset, Decreases Payable Liability |
| **Payment In** | No Impact | $+ \text{Cash/Bank}$ | $- \text{Receivable Balance}$ | Increases Cash Asset, Decreases Receivable Asset |
| **Expense Entry** | No Impact | $- \text{Cash/Bank}$ | No Impact | Decreases Net Income (P&L Expense) |
| **Purchase Return** | $- \text{Stock Quantity}$ | $+ \text{Refund Received}$ | $- \text{Payable Balance}$ | Decreases Stock Asset, Decreases Payable Liability |
| **Sales Return** | $+ \text{Stock Quantity}$ | $- \text{Refund Paid}$ | $- \text{Receivable Balance}$ | Increases Stock Asset, Decreases Sales Revenue |

### B. Core Accounting Equations
1. **Gross Profit**:
   $$\text{Gross Profit} = \text{Total Sales Revenue} - \text{Cost of Goods Sold (COGS)} + \text{Stock Adjustments}$$
   $$\text{COGS} = \text{Opening Stock} + \text{Purchases} - \text{Closing Stock}$$
2. **Net Profit**:
   $$\text{Net Profit} = \text{Gross Profit} - \text{Total Operating Expenses} - \text{Loan Interest \& Processing Fees}$$
3. **Balance Sheet Equation**:
   $$\text{Total Assets} = \text{Total Liabilities} + \text{Owner's Equity (Capital + Net Profit)}$$
   - **Assets**: Cash in Hand + Bank Balances + Outstanding Receivables + Closing Inventory Value + Fixed Assets.
   - **Liabilities**: Outstanding Payables + Bank Loans / Overdrafts + Tax Payables.

---

## 4. Complete Step-by-Step UI Navigation & Button-by-Button Click Guide

Software UI ko use karte waqt kon sa button kahan hai aur button click karne par kya dialog open hota hai, iska poora navigational blueprint neche diya gaya hai:

```
+-------------------------------------------------------------------------------------------------+
| TOP TOOLBAR:  [Company Dropdown v]   [Search bar...]   [+ Add Sale (Alt+S)]   [+ Add Purchase]   |
+-------------------------------------------------------------------------------------------------+
| LEFT NAVIGATION SIDEBAR   | MAIN DASHBOARD CONTENT AREA                                        |
|---------------------------|---------------------------------------------------------------------|
| * Dashboard               |  [ Total Sales ]  [ Total Cash ]  [ You Receive ]  [ You Pay ]          |
| * Sale                    |  +---------------------------------------------------------------+  |
|   - Sale Invoices         |  | Real-Time Sales Graph & Transaction History Table            |  |
|   - Estimates / Quotes    |  +---------------------------------------------------------------+  |
|   - Payment In            |                                                                     |
|   - Sale Return           |  QUICK ACTION BUTTONS:                                              |
| * Purchase                |  [ + Add Sale ]   [ + Add Purchase ]   [ + Add More v ]              |
|   - Purchase Bills        |                                                                     |
|   - Payment Out           |  CRITICAL ALERTS:                                                   |
|   - Purchase Return       |  * Low Stock Alerts List                                            |
| * Items                   |  * Overdue Payment Reminders List                                   |
|   - Inventory Stock       |                                                                     |
| * Parties                 |                                                                     |
|   - Customers / Suppliers |                                                                     |
| * Cash & Bank             |                                                                     |
| * Expenses                |                                                                     |
| * Reports                 |                                                                     |
| * Settings                |                                                                     |
+-------------------------------------------------------------------------------------------------+
```

---

### Navigation Flow 1: App Installation & Company Profile Creation

1. **Browser Navigation**: Chrome browser open karein $\rightarrow$ URL `vyaparapp.in` visit karein $\rightarrow$ Click **Download for Desktop** button.
2. **Installation**: Setup `.exe` file double-click karke install karein $\rightarrow$ Desktop shortcut icon se app open karein.
3. **Login Dialog**: Screen par Mobile Number prompt aayega $\rightarrow$ Enter 10-digit mobile number $\rightarrow$ Click **Get OTP** $\rightarrow$ Enter OTP $\rightarrow$ Click **Verify & Login**.
4. **Company Creation Navigation**:
   - **Step A**: Top-Left Header Bar mein **Company Name** (Default: My Company) dropdown par click karein.
   - **Step B**: Click **Change Company** $\rightarrow$ Click **+ Create New Company** button.
   - **Step C**: *Add Company Modal* open hoga:
     - Input `Business Name` (e.g., SM Infotech).
     - Input `Phone Number` & `Email ID`.
     - Select `Country` (India).
     - Click **Save & Continue** button.
5. **Business Profile & Logo Upload Navigation**:
   - **Step A**: Left Menu Sidebar mein **Settings** (Bottom Gear Icon) par click karein $\rightarrow$ Select **Company Profile**.
   - **Step B**: Click **+ Add Business Logo** box $\rightarrow$ File chooser se Shop Logo image (`.jpg`/`.png`) select karke Open click karein.
   - **Step C**: `GSTIN` field mein 15-digit GST Number enter karein.
   - **Step D**: Click **Add More Information** link:
     - Input `Registered Address`, `Pincode`, `State` (Place of Supply).
     - Select `Business Type` (Retail / Wholesale) & `Business Category`.
     - Click **+ Add Signature** box $\rightarrow$ Authorized Signatory image upload karein.
   - **Step E**: Bottom-Right corner mein **Save** button par click karein.

---

### Navigation Flow 2: Bank Account & Cash Capital Setup

#### A. Bank Account Add Karna
1. Left Menu Sidebar mein **Cash & Bank** option par click karein $\rightarrow$ Sub-menu **Bank Accounts** select karein.
2. Top-Right corner mein **+ Add Bank Account** green button par click karein.
3. *Add Bank Account Window* open hogi:
   - `Account Display Name`: Enter Bank Name (e.g., SBI Current Account).
   - `Opening Balance`: Enter balance (e.g., ₹5,000).
   - `As of Date`: Date picker se select karein.
4. **Print Bank Details Toggle**:
   - Enable checkbox **Print Bank Details on Invoice**.
   - Additional fields open honge: Input `Account Number`, `IFSC Code`, `Bank & Branch Name`, `Account Holder Name`, `UPI ID for QR Code`.
5. Click **Save** button.

#### B. Cash In Hand (Capital Injection) Setup
1. Left Menu Sidebar mein **Cash & Bank** $\rightarrow$ Click **Cash In Hand**.
2. Right side action area mein **Adjust Cash** button par click karein $\rightarrow$ Select **Add Cash**.
3. *Adjust Cash Window* open hogi:
   - Enter `Amount` (e.g., ₹50,000 Initial Capital).
   - Select `Category`: **Capital / Asset**.
   - Input `Remark`: "Initial Owner Capital Injection".
4. Click **Save** button. Cash Balance dashboard par ₹50,000 reflect ho jayega.

---

### Navigation Flow 3: Item Master & Inventory Creation

#### A. Single Item Manually Create Karna
1. Left Menu Sidebar mein **Items** tab par click karein.
2. Top-Right corner mein **+ Add Item** button par click karein.
3. *Add Item Modal Dialog* pop-up hoga (Ismein 3 main tabs hain):

##### Tab 1: Basic Details
- `Item Name`: Enter product name (e.g., Fantech Keyboard).
- `Select Type`: Select radio button **Product** (for goods) or **Service**.
- `Item Code / Barcode`: Enter serial/barcode number ya click **Scan Barcode** icon.
- `Category`: Click **+ Add Category** $\rightarrow$ Type "Keyboards" $\rightarrow$ Click Save. Select "Keyboards".
- `Unit`: Click **Select Unit** dropdown $\rightarrow$ Choose **PCS (Pieces)**. (Nayi unit banane ke liye click **+ Add Unit**).

##### Tab 2: Pricing Details
- `Sales Price`: Enter selling rate (e.g., ₹300).
  - Select dropdown: **With Tax** or **Without Tax**.
- `Purchase Price`: Enter purchase rate (e.g., ₹250).
  - Select dropdown: **With Tax** or **Without Tax**.
- `Tax Rate / GST`: Dropdown se select GST percentage (e.g., GST@18%).
- `HSN Code`: Enter 4-digit or 8-digit HSN code (e.g., 8471).

##### Tab 3: Stock Details
- `Opening Stock`: Enter initial stock quantity (e.g., 10).
- `Min Stock Alert`: Enter threshold quantity (e.g., 2). Jab stock 2 se kam hoga, red warning highlight hogi.
- `Item Location / Rack`: Enter rack number (e.g., Rack A-1).

4. Bottom-Right corner mein **Save** button par click karein.

#### B. Bulk Excel Import Navigation
1. Left Menu **Items** par click karein $\rightarrow$ Top-Right menu button **... (Three Dots / Action Menu)** par click karein.
2. Select **Import Items from Excel**.
3. Window mein **Download Sample Excel Template** link par click karein.
4. Downloaded Excel sheet mein Items, Prices, HSN, Stock fill karein.
5. Click **Upload File** button $\rightarrow$ Excel file select karein $\rightarrow$ Column Mapping verify karein $\rightarrow$ Click **Import** button.

---

### Navigation Flow 4: Party Creation & Credit Setup

1. Left Menu Sidebar mein **Parties** tab par click karein.
2. Top-Right corner mein **+ Add Party** button par click karein.
3. *Add Party Modal Dialog* open hoga:

#### Tab 1: Party Details
- `Party Name`: Enter Customer or Supplier name (e.g., ABC Infotech).
- `GST Type`: Select dropdown (**Unregistered**, **Registered Regular**, **Composition**, **Consumer**).
- `GSTIN`: Enter 15-digit GSTIN (if Registered Regular).
- `Phone Number`: Enter 10-digit mobile number.
- `State`: Select State (e.g., Maharashtra) - *Inter-state vs Intra-state GST calculation ke liye zaroori hai*.

#### Tab 2: Address & Credit Settings
- `Billing Address`: Input complete office/shop address.
- `Shipping Address`: Checkbox **Same as Billing Address** enable karein ya alag address dalein.
- `Opening Balance`: Enter amount (e.g., ₹1,000).
  - Select radio button: **To Pay (Payable)** for Supplier OR **To Receive (Receivable)** for Customer.
- `Credit Limit`: Enable **Set Credit Limit** checkbox $\rightarrow$ Enter Max Due Amount (e.g., ₹50,000) & Max Credit Period (e.g., 30 Days).

4. Click **Save** button.

---

### Navigation Flow 5: Purchase Inward Entry & Stock Ingestion

1. **Navigation Path**:
   - **Method A (Quick)**: Top Toolbar / Dashboard par **+ Add Purchase** blue button par click karein.
   - **Method B (Sidebar)**: Left Sidebar $\rightarrow$ **Purchase** $\rightarrow$ **Purchase Bills** $\rightarrow$ Click **+ Add Purchase** button.
2. *Purchase Invoice Form Screen* open hogi:

```
+---------------------------------------------------------------------------------------------------+
| PURCHASE INVOICE                                                          Bill No: [ 1024       ]     |
| Party Name: [ Select Supplier v ] (+ Add Party)                           Date:    [ 12/10/2026 v ]     |
+---------------------------------------------------------------------------------------------------+
| #  | ITEM NAME          | QTY  | UNIT | PRICE/UNIT | DISCOUNT | TAX (%) | TOTAL (INR)           |
|----+--------------------+------+------+------------+----------+---------+-----------------------|
| 1  | Fantech Keyboard   | 10   | PCS  | 250        | 0        | 18%     | 2,950.00              |
|----+--------------------+------+------+------------+----------+---------+-----------------------|
| [+ Add Line Item]                                                                                 |
+---------------------------------------------------------------------------------------------------+
| Payment Type: [ Cash / Bank Account v ]                   Subtotal:     2,500.00                  |
| Paid Amount:  [ 2,000.00              ]                   Tax (18%):      450.00                  |
| Balance Due:  [ 950.00                ]                   Total Amount: 2,950.00                  |
+---------------------------------------------------------------------------------------------------+
| [ Save & Print ]                                                         [ Save (Ctrl+S) ]        |
+---------------------------------------------------------------------------------------------------+
```

3. **Field Inputs**:
   - `Party Name`: Dropdown se Supplier Name (ABC Infotech) select karein (ya click `+ Add Party`).
   - `Purchase Bill No`: Supplier ke invoice par chapa bill number enter karein (e.g., `BILL-889`).
   - `Item Table`:
     - `Item`: Type/Select "Fantech Keyboard".
     - `Quantity`: Enter `10`.
     - `Price/Unit`: Auto-filled `250` (editable).
   - `Payment Settlement Section`:
     - `Payment Type`: Dropdown se Cash ya Bank select karein.
     - `Paid Amount`: Fill amount (e.g., ₹2,000 Paid).
     - `Balance Due`: System automatically ₹950 Due calculate karega.
4. **Action**: Bottom-Right corner mein **Save** button (or `Ctrl+S`) par click karein.
   - *System Back-End Action*: Inventory mein +10 PCS add ho jayein ge, Bank/Cash se ₹2,000 deduct ho jayega, aur Supplier Account mein ₹950 Payable Due credit ho jayega.

---

### Navigation Flow 6: Sales Invoicing / Billing & Invoice Printing

1. **Navigation Path**:
   - **Method A (Keyboard Shortcut)**: Press `Alt + S` keyboard key.
   - **Method B (Dashboard)**: Click **+ Add Sale** red button.
   - **Method C (Sidebar)**: Left Sidebar $\rightarrow$ **Sale** $\rightarrow$ **Sale Invoices** $\rightarrow$ Click **+ Add Sale**.
2. *Sales Invoice Form Screen* open hogi:
   - `Customer Name`: Select Customer (e.g., Kas1) or keep "Cash Sale".
   - `Invoice Number`: Auto-generated numeric string (e.g., `INV-12`).
   - `Invoice Date`: Auto-populated current date.
   - `Item Selection`: Search & Select "Fantech Keyboard" $\rightarrow$ Quantity enter `1` PC. Price auto-fills ₹300.
   - `Discount Line Item`: Enter Discount % or Flat Amount if applicable.
   - `Tax Split`: System auto-calculates CGST (9%) + SGST (9%) for intra-state.
   - `Received Amount`: Enter payment received from customer (e.g., Full ₹300 or Partial ₹250).
   - `Payment Mode`: Select Cash, UPI/QR Code, or Bank.
3. **Save & Print Actions**:
   - Click **Save & Print** button.
   - *Print Preview Window* open hogi:
     - Theme chooser: Select **A4 Regular**, **A5 Compact**, ya **3-inch Thermal Print**.
     - Action Buttons: Click **Print Now**, **Save as PDF**, ya **Share on WhatsApp**.

---

### Navigation Flow 7: Dues Settlement (Payment In & Payment Out)

#### A. Customer Due Receive Karna (Payment In)
1. **Navigation**: Left Sidebar $\rightarrow$ **Sale** $\rightarrow$ Click **Payment In** $\rightarrow$ Click **+ Add Payment In** button (or Dashboard `+ Add More` dropdown $\rightarrow$ `Payment In`).
2. *Payment In Window* open hogi:
   - `Party Name`: Select Customer (Kas1).
   - `Received Amount`: System displays total outstanding due. Enter received cash/bank amount (e.g., ₹50).
   - `Payment Mode`: Select Cash or Bank.
   - `Bill Linking Section`: System pending invoices ki list dikhayega. Tick checkbox to link payment to Invoice #INV-12.
3. Click **Save** button. Customer outstanding balance zero ho jayega.

#### B. Supplier Due Payment Karna (Payment Out)
1. **Navigation**: Left Sidebar $\rightarrow$ **Purchase** $\rightarrow$ Click **Payment Out** $\rightarrow$ Click **+ Add Payment Out** button.
2. *Payment Out Window* open hogi:
   - `Party Name`: Select Supplier (ABC Infotech).
   - `Paid Amount`: Enter amount (e.g., ₹950).
   - `Payment Mode`: Select SBI Current Account.
3. Click **Save** button. Supplier balance zero ho jayega aur Bank Account se ₹950 deduct ho jayege.

---

### Navigation Flow 8: Operational Expense Entry

1. **Navigation**: Left Sidebar $\rightarrow$ Click **Expenses** tab $ightarrow$ Click **+ Add Expense** button.
2. *Add Expense Screen* open hogi:
   - `Expense Category`: Select pre-existing category (**Rent**, **Salary**, **Transport/Freight**, **Tea/Tiffin**, **Electricity**) or click **+ Add Category**.
   - `Expense Item Name`: Input description (e.g., Goods Freight Delivery Charge).
   - `Amount`: Input amount (e.g., ₹350).
   - `Payment Type`: Select Cash or Bank Account.
3. Click **Save** button. Expense P&L Statement mein auto-deduct ho jayega.

---

### Navigation Flow 9: Reports & Analytics Navigation

1. **Navigation**: Left Sidebar $\rightarrow$ Click **Reports** tab.
2. *Reports Gallery Window* open hogi (Categorized into 5 main report hubs):

```
+---------------------------------------------------------------------------------------------------+
| REPORTS GALLERY                                                                                   |
+---------------------------------------------------------------------------------------------------+
| FINANCIAL REPORTS          | TRANSACTION REPORTS        | INVENTORY REPORTS     | PARTY REPORTS   |
| * Profit & Loss            | * Sale Report              | * Stock Summary       | * Party Statement|
| * Balance Sheet            | * Purchase Report          | * Low Stock Summary   | * All Parties   |
| * Cash Flow Statement      | * Daybook                  | * Item Detail Report  | * Receivables   |
| * Trial Balance            | * All Transactions         | * Batch / Expiry      | * Payables      |
+---------------------------------------------------------------------------------------------------+
| GST COMPLIANCE REPORTS                                                                            |
| * GSTR-1 (Outward)   * GSTR-2 (Inward)   * GSTR-3B Summary   * GSTR-9 Annual   * HSN Summary      |
+---------------------------------------------------------------------------------------------------+
```

3. **Generating a Report**:
   - Click on desired report name (e.g., **Profit & Loss** or **GSTR-1**).
   - Top Header Controls:
     - `Date Filter`: Select Date Range dropdown (**Today**, **This Month**, **This Quarter**, **Custom Date**).
     - `Export Action Buttons`: Click **Excel Export** (for `.xlsx`), **PDF Export**, ya **Print**.

---

### Navigation Flow 10: Settings & Application Configuration

1. **Navigation**: Left Sidebar $\rightarrow$ Click **Settings** (Bottom Gear Icon).
2. **Key Sub-Settings Panels**:
   - **Transaction Settings**: Enable/disable Invoice Prefix, Round-Off Amounts, Purchase Order flow, Credit Limits, Due Date Reminders, Deletion Passwords.
   - **Print Settings**: Select Printer Type (Laser/Inkjet A4 vs Thermal 2"/3"), Toggle Logo Printing, Toggle UPI Payment QR Code, Custom Header/Footer text.
   - **Tax Settings**: Enable GST billing, HSN/SAC requirement, Inclusive/Exclusive tax defaults.
   - **User Management & Security**: Admin & Operator role management, Password protection for transaction deletion.
   - **Backup & Restore**: Click **Auto Backup to Google Drive** toggle ON, or click **Backup to Computer** to save a local `.vyapar` encrypted backup file.

---

## 5. Master Navigation & Logic Summary Matrix

| Task / Operation | Navigation Path & Button Click | Core Primary Action | System Ledger & Database Impact |
| :--- | :--- | :--- | :--- |
| **New Firm Creation** | Top Toolbar `Company Dropdown` $\rightarrow$ `Change Company` $\rightarrow$ Click `+ Create New Company` | Enter Name & Mobile $\rightarrow$ Save | Creates isolated database workspace |
| **Add Bank Account** | Sidebar `Cash & Bank` $\rightarrow$ `Bank Accounts` $\rightarrow$ Click `+ Add Bank Account` | Fill Account No, IFSC, QR Details $\rightarrow$ Save | Adds Asset Account to Balance Sheet |
| **Add Inventory Item** | Sidebar `Items` $\rightarrow$ Click `+ Add Item` | Fill Name, Unit, Price, Tax, Opening Stock $\rightarrow$ Save | Creates Item Record, Sets Initial Inventory Value |
| **Record Purchase** | Dashboard `+ Add Purchase` OR Sidebar `Purchase` $\rightarrow$ Click `+ Add Purchase` | Select Supplier, Item, Qty, Paid/Due Amount $\rightarrow$ Save | Increases Inventory (+Stock), Deducts Cash, Creates Payable |
| **Record Sale / Bill** | Dashboard `+ Add Sale` (or `Alt+S`) | Select Customer, Item, Qty, Received Amount $\rightarrow$ Save & Print | Decreases Inventory (-Stock), Adds Cash, Creates Receivable |
| **Collect Customer Due**| Sidebar `Sale` $\rightarrow$ `Payment In` $\rightarrow$ Click `+ Add Payment In` | Choose Customer, Amount, Link Invoice $\rightarrow$ Save | Increases Cash, Decreases Customer Receivable Balance |
| **Pay Supplier Due** | Sidebar `Purchase` $\rightarrow$ `Payment Out` $\rightarrow$ Click `+ Add Payment Out` | Choose Supplier, Bank, Amount $\rightarrow$ Save | Decreases Bank Balance, Decreases Payable Balance |
| **Record Expense** | Sidebar `Expenses` $\rightarrow$ Click `+ Add Expense` | Choose Category, Amount, Payment Mode $\rightarrow$ Save | Deducts Cash/Bank, Increases P&L Expense |
| **View Profit & Loss** | Sidebar `Reports` $\rightarrow$ Click `Profit & Loss` | Select Date Range $\rightarrow$ Export PDF/Excel | Computes Revenue - COGS - Expenses = Net Profit |

---
*Dastaavez Vyapar App Desktop Official Video Tutorials & Architecture Guidelines par aadharit hai.*
