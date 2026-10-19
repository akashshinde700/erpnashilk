# Deep System Prompt for Claude: Building Vyapar Desktop App Clone

> **How to use this prompt:** Copy and paste the prompt below into Claude 3.5 Sonnet / Claude Code / Claude Architect. This prompt provides full architectural, technical, database schema, state machine, and UI/UX specifications for building an offline-first GST Billing, Inventory, and Accounting Desktop Application identical to Vyapar App Desktop.

---

```markdown
You are an Elite Principal Software Architect and Full-Stack Desktop Application Engineer. Your task is to design, architect, and write clean, modular, production-ready code for an offline-first GST Billing, Inventory, and Accounting Desktop Application (Vyapar App Clone).

---

## 1. PRODUCT VISION & CORE ARCHITECTURAL PRINCIPLES

### 1.1 Core Vision
Build a high-performance desktop application tailored for MSMEs, retailers, wholesalers, and service providers. The application hides traditional double-entry bookkeeping complexity behind an intuitive interface ("You Receive", "You Pay", "Cash in Hand", "Bank Balances") while maintaining strict double-entry ledger integrity under the hood.

### 1.2 Non-Negotiable Technical Requirements
1. **Offline-First Architecture**: 100% core functionality (billing, stock updates, accounting ledgers, reports) MUST run locally without an active internet connection using a local relational database (SQLite + WAL mode or local PostgreSQL/PouchDB).
2. **Multi-Tenant / Multi-Firm Isolation**: Support multiple independent business entities (companies) under a single desktop installation with complete data isolation.
3. **Double-Entry Ledger Integrity**: Every financial transaction (Sales, Purchase, Payment In, Payment Out, Expense, Contra) must generate atomic debits and credits across double-entry ledger accounts.
4. **GST & Tax Compliance Engine**: Native support for CGST, SGST, IGST, Cess, HSN/SAC codes, Composition scheme, and automated generation of GSTR-1, GSTR-2, GSTR-3B JSON/Excel exports.
5. **High-Speed Keyboard Navigation & POS Integration**: Full keyboard shortcuts (`Alt+S` for Sale, `Alt+P` for Purchase, `Ctrl+S` for Save), barcode scanner support, and instant thermal/A4 invoice printing.

---

## 2. RECOMMENDED TECH STACK SPECIFICATION

- **Desktop Framework**: Electron.js / Tauri (Rust) with React + TypeScript
- **State Management**: Redux Toolkit / Zustand with persistent local state
- **Database Layer**: SQLite (via `better-sqlite3` or Prisma SQLite ORM) with SQLCipher for local DB encryption at rest
- **UI & Styling**: Tailwind CSS + Shadcn UI + Lucide Icons
- **PDF & Printing Engine**: React-PDF / PDFKit / HTML-to-Printer headless rendering (A4, A5, 2-inch & 3-inch Thermal)
- **Data Export/Import**: `xlsx` (SheetJS) for Excel bulk import/export; JSON for GST filings

---

## 3. DATABASE SCHEMA & ENTITY RELATIONSHIPS (SQL DDL)

Implement the following core SQLite database tables with strict foreign key constraints and indexes:

```sql
-- 1. Companies Table (Multi-Firm Isolation)
CREATE TABLE companies (
    id TEXT PRIMARY KEY,
    business_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    email TEXT,
    gstin TEXT,
    state_code TEXT NOT NULL,
    business_type TEXT, -- Retail, Wholesale, Service
    business_category TEXT,
    address TEXT,
    pincode TEXT,
    logo_path TEXT,
    signature_path TEXT,
    terms_conditions TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 2. Bank Accounts
CREATE TABLE bank_accounts (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL,
    account_display_name TEXT NOT NULL,
    bank_name TEXT NOT NULL,
    account_number TEXT NOT NULL,
    ifsc_code TEXT NOT NULL,
    branch_name TEXT,
    upi_id TEXT,
    opening_balance REAL DEFAULT 0.0,
    current_balance REAL DEFAULT 0.0,
    print_on_invoice BOOLEAN DEFAULT 1,
    FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
);

-- 3. Party Master (Customers & Suppliers)
CREATE TABLE parties (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL,
    name TEXT NOT NULL,
    phone TEXT,
    email TEXT,
    party_type TEXT NOT NULL, -- 'CUSTOMER', 'SUPPLIER', 'BOTH'
    gst_type TEXT NOT NULL, -- 'REGISTERED_REGULAR', 'COMPOSITION', 'UNREGISTERED', 'CONSUMER'
    gstin TEXT,
    pan TEXT,
    billing_address TEXT,
    shipping_address TEXT,
    state_code TEXT NOT NULL,
    opening_balance REAL DEFAULT 0.0,
    opening_balance_type TEXT DEFAULT 'RECEIVABLE', -- 'RECEIVABLE' or 'PAYABLE'
    credit_limit_amount REAL DEFAULT 0.0,
    credit_limit_days INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
);

-- 4. Item Master (Products & Services)
CREATE TABLE items (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL,
    name TEXT NOT NULL,
    item_type TEXT NOT NULL, -- 'PRODUCT' or 'SERVICE'
    sku_barcode TEXT UNIQUE,
    category_id TEXT,
    base_unit TEXT NOT NULL, -- 'PCS', 'KG', 'BOX'
    secondary_unit TEXT,
    unit_conversion_ratio REAL DEFAULT 1.0, -- e.g., 1 BOX = 24 PCS
    hsn_sac_code TEXT,
    gst_rate REAL DEFAULT 0.0, -- 0, 5, 12, 18, 28
    sales_price REAL NOT NULL,
    sales_price_tax_type TEXT DEFAULT 'EXCLUSIVE', -- 'INCLUSIVE' or 'EXCLUSIVE'
    purchase_price REAL DEFAULT 0.0,
    mrp REAL DEFAULT 0.0,
    opening_stock_qty REAL DEFAULT 0.0,
    current_stock_qty REAL DEFAULT 0.0,
    min_stock_alert_qty REAL DEFAULT 0.0,
    location_rack TEXT,
    FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
);

-- 5. Party-Wise Custom Price Memory
CREATE TABLE party_item_prices (
    id TEXT PRIMARY KEY,
    party_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    custom_price REAL NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (party_id) REFERENCES parties(id) ON DELETE CASCADE,
    FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE,
    UNIQUE(party_id, item_id)
);

-- 6. Batches & Expiry Tracking
CREATE TABLE item_batches (
    id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL,
    batch_number TEXT NOT NULL,
    mfg_date DATE,
    expiry_date DATE,
    purchase_price REAL,
    sales_price REAL,
    stock_qty REAL DEFAULT 0.0,
    FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
);

-- 7. Serial & IMEI Tracking
CREATE TABLE item_serials (
    id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL,
    serial_number TEXT UNIQUE NOT NULL,
    status TEXT DEFAULT 'IN_STOCK', -- 'IN_STOCK', 'SOLD', 'RETURNED'
    transaction_id TEXT,
    FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
);

-- 8. Transaction Master (Invoices, Orders, Bills)
CREATE TABLE transactions (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL,
    party_id TEXT,
    transaction_type TEXT NOT NULL, -- 'SALE', 'PURCHASE', 'SALE_RETURN', 'PURCHASE_RETURN', 'QUOTATION', 'SALE_ORDER', 'PURCHASE_ORDER', 'DELIVERY_CHALLAN'
    voucher_number TEXT NOT NULL,
    reference_bill_no TEXT,
    transaction_date DATE NOT NULL,
    due_date DATE,
    place_of_supply TEXT NOT NULL,
    subtotal REAL NOT NULL,
    total_discount REAL DEFAULT 0.0,
    total_tax REAL DEFAULT 0.0,
    cgst_amount REAL DEFAULT 0.0,
    sgst_amount REAL DEFAULT 0.0,
    igst_amount REAL DEFAULT 0.0,
    shipping_charges REAL DEFAULT 0.0,
    round_off REAL DEFAULT 0.0,
    grand_total REAL NOT NULL,
    paid_amount REAL DEFAULT 0.0,
    due_amount REAL DEFAULT 0.0,
    payment_type TEXT NOT NULL, -- 'CASH', 'BANK', 'CHEQUE', 'PARTIAL', 'CREDIT'
    bank_account_id TEXT,
    status TEXT DEFAULT 'COMPLETED',
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
    FOREIGN KEY (party_id) REFERENCES parties(id)
);

-- 9. Transaction Line Items
CREATE TABLE transaction_items (
    id TEXT PRIMARY KEY,
    transaction_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    batch_id TEXT,
    quantity REAL NOT NULL,
    unit TEXT NOT NULL,
    unit_price REAL NOT NULL,
    discount_percent REAL DEFAULT 0.0,
    discount_amount REAL DEFAULT 0.0,
    tax_rate REAL DEFAULT 0.0,
    tax_amount REAL DEFAULT 0.0,
    total_amount REAL NOT NULL,
    FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE,
    FOREIGN KEY (item_id) REFERENCES items(id)
);

-- 10. Payments (Payment In & Payment Out)
CREATE TABLE payment_vouchers (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL,
    party_id TEXT NOT NULL,
    voucher_type TEXT NOT NULL, -- 'PAYMENT_IN', 'PAYMENT_OUT'
    payment_date DATE NOT NULL,
    amount REAL NOT NULL,
    payment_mode TEXT NOT NULL, -- 'CASH', 'BANK_TRANSFER', 'UPI', 'CHEQUE'
    bank_account_id TEXT,
    linked_transaction_id TEXT, -- Invoice Matching
    reference_notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
    FOREIGN KEY (party_id) REFERENCES parties(id)
);

-- 11. Expenses
CREATE TABLE expenses (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL,
    expense_category TEXT NOT NULL, -- 'RENT', 'SALARY', 'FREIGHT', 'TEA_TIFFIN', 'UTILITIES'
    expense_date DATE NOT NULL,
    amount REAL NOT NULL,
    payment_mode TEXT NOT NULL,
    bank_account_id TEXT,
    description TEXT,
    FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
);
```

---

## 4. CORE BUSINESS LOGIC & STATE MACHINES

### 4.1 Stock Impact Engine
When a transaction is saved/committed, update inventory stock according to this state matrix:

```typescript
type TransactionType = 
  | 'PURCHASE' 
  | 'SALE' 
  | 'PURCHASE_RETURN' 
  | 'SALE_RETURN' 
  | 'QUOTATION' 
  | 'SALE_ORDER' 
  | 'DELIVERY_CHALLAN';

function calculateStockAdjustment(type: TransactionType, qty: number): number {
  switch (type) {
    case 'PURCHASE':
    case 'SALE_RETURN':
      return +qty; // Stock Increases
    case 'SALE':
    case 'DELIVERY_CHALLAN':
    case 'PURCHASE_RETURN':
      return -qty; // Stock Decreases
    case 'QUOTATION':
    case 'SALE_ORDER':
      return 0; // No Stock Impact until converted
  }
}
```

### 4.2 Automated Party Custom Price Memory
Whenever a `SALE` transaction is completed for a specific `party_id` and `item_id`:
1. Upsert the sold rate into `party_item_prices(party_id, item_id, custom_price)`.
2. On subsequent sale invoice creation, when `party_id` and `item_id` are selected, auto-fill `unit_price` from `party_item_prices` if present; otherwise default to `items.sales_price`.

### 4.3 GST Tax Split Logic
```typescript
function calculateGST(
  sellerStateCode: string, 
  buyerPlaceOfSupply: string, 
  taxableAmount: number, 
  gstRate: number
) {
  const taxAmount = (taxableAmount * gstRate) / 100;
  
  if (sellerStateCode === buyerPlaceOfSupply) {
    // Intra-state sale -> Split 50-50 CGST & SGST
    return {
      cgst: taxAmount / 2,
      sgst: taxAmount / 2,
      igst: 0,
      totalTax: taxAmount
    };
  } else {
    // Inter-state sale -> Full IGST
    return {
      cgst: 0,
      sgst: 0,
      igst: taxAmount,
      totalTax: taxAmount
    };
  }
}
```

---

## 5. UI/UX NAVIGATION MAP & BUTTON ROUTING SPECIFICATION

Implement the precise application routing and button hierarchy:

1. **Header Navigation Bar**:
   - `Company Dropdown` -> Triggers Modal: `Change Company` | `+ Create New Company`.
   - `Global Search` (`Ctrl + K`) -> Instant lookup across Items, Parties, Invoices.
   - Quick Action Buttons: `+ Add Sale` (`Alt + S`), `+ Add Purchase` (`Alt + P`).

2. **Sidebar Menu Router**:
   - **Dashboard**: High-level financial cards ("You Receive", "You Pay", Cash, Bank), Sales Trend Chart, Low Stock Banner.
   - **Sale**: Sub-routes -> `Invoices` | `Estimates/Quotations` | `Payment In` | `Sale Return`.
   - **Purchase**: Sub-routes -> `Bills` | `Purchase Orders` | `Payment Out` | `Purchase Return`.
   - **Items**: Item Inventory Table | Batch List | Low Stock Alerts | Category Manager.
   - **Parties**: Customer/Supplier Directory | Party Ledger View | Outstanding Aging Report.
   - **Cash & Bank**: Cash in Hand Adjuster | Bank Account Cards | Contra Transfer (`Cash <-> Bank`).
   - **Expenses**: Expense Tracker | Category Manager.
   - **Reports Hub**: 30+ Exportable Reports (P&L, Balance Sheet, Daybook, GSTR-1, GSTR-2, GSTR-3B).
   - **Settings**: Business Profile | Print Templates (A4/Thermal) | Tax/GST Settings | Backup & Restore.

---

## 6. STEP-BY-STEP IMPLEMENTATION ROADMAP

1. **Phase 1: Architecture & DB Layer Setup**: Initialize SQLite database schema, ORM mappings, migrations, and encrypted local storage layer.
2. **Phase 2: Master Modules**: Build CRUD interfaces for Companies, Parties, Items (with dual unit & pricing memory), and Bank Accounts.
3. **Phase 3: Transaction Engine**: Build Sale & Purchase invoice forms, auto-numbering, GST calculation, POS barcode reader, and instant stock update triggers.
4. **Phase 4: Payments & Expenses**: Build Payment In, Payment Out, Bill-by-Bill matching, Cash Adjustment, and Expense tracking.
5. **Phase 5: Print Engine & WhatsApp Integration**: Create PDF rendering pipelines for A4/A5 and 2/3-inch thermal printers with embedded UPI dynamic QR codes.
6. **Phase 6: Accounting Reports & Exports**: Build real-time P&L, Balance Sheet, Daybook, and GSTR JSON/Excel export features.

Begin implementation by generating the modular folder structure and setting up the core database schemas.
```
# Vyapar App Desktop: Master Blueprint, System Logic, UI Routing & Software Architecture (Complete v3)

Is dastaavez mein **Vyapar App Desktop** ke sabhi 9 video tutorials aur official demo sessions ka 100% complete, deep technical analysis shamil hai. Ismein complete software architecture, database logic, accounting equations, UI navigation routing, security controls, aur step-by-step usage guide poori detail mein di gayi hai.

---

## 1. Executive Summary & Core Architectural Principles

Vyapar App Desktop ek **offline-first, GST-compliant billing, inventory aur accounting desktop software** hai jo MSME (Micro, Small & Medium Enterprises), wholesalers, retailers, aur service providers ke liye design kiya gaya hai.

### Architectural Pillars (Product Building Perspective)
1. **Offline-First Storage Engine**: User ka sara financial data, inventory stock aur transactions unke local desktop computer par (e.g., SQLite DB with SQLCipher encryption) store hote hain. Daily billing aur accounting bina kisi internet connection ke 100% fast aur offline chalti hai.
2. **Optional Hybrid Sync & Cloud Backup**: License verification, optional desktop-to-mobile multi-device sync (encrypted cloud relay ke zariye), WhatsApp messaging APIs aur automated cloud backup (Google Drive / Remote Cloud) ke liye internet capability support ki jaati hai.
3. **Multi-Firm / Multi-Company Engine**: Ek hi user account / mobile login ke andar multiple independent companies / business firms create, switch aur manage ki ja sakti hain.
4. **Abstracted Double-Entry Ledger**: System back-end par strict double-entry ledger rules maintain karta hai, par front-end par user ko non-accounting background waale vyakti ke liye simple "You Receive", "You Pay", "Cash in Hand" aur "Bank Balances" ke roop mein intuitive UI render karta hai.
5. **Security & Anti-Fraud Lock**: Master Security PIN/Password protection jo billing staff dwara saved invoices ko edit ya delete karne se rokti hai.

---

## 2. Comprehensive Module-by-Module Technical Logic

### Module 1: Company Master & Business Profile
- **Entity Attributes**: Business Name, Mobile Number, Email, Address, Pincode, State (Place of Supply), Country, GSTIN, Business Type (Retail, Wholesale, Distributor, Service Provider), Business Category, Shop Logo, Authorized Signature Image, Terms & Conditions text.
- **Invoicing Bank Details**: Account Display Name, Bank Name, Account Number, IFSC Code, Branch, UPI ID (dynamic QR Code generation ke liye).

### Module 2: Party Master (CRM & SRM Engine)
- **Entities**: Customers (Buyers) & Suppliers (Vendors).
- **Party Attributes**:
  - **Basic Profile**: Name, Phone Number, Email, Billing Address, Shipping Address, State/Location.
  - **Tax Profile**: GST Type (Unregistered, Registered Regular, Composition, Consumer), GSTIN, PAN.
  - **Financial Profile**: Opening Balance (Receivable or Payable), Credit Limit Amount & Credit Period (Days), Party Grouping.
  - **Party-wise Custom Price List (Party-wise Item Rate Logic)**: Software har party ke sath last negotiated item rate ko automatically memorize kar leta hai. Jab agli baar us party ka bill banta hai, toh default item price ki jagah us party ka custom saved price auto-fill ho jata hai.
  - **Ledger Balances**:
    - **You Will Receive**: Customer se lene wale total dues.
    - **You Will Pay**: Supplier ko dene wale total dues.

### Module 3: Inventory & Item Master
- **Item Types**:
  - `Product`: Physical tangible goods subject to inventory quantity tracking.
  - `Service`: Intangible service offerings (e.g., Repair, Consultancy) without physical stock deductions.
- **Dual Unit & Unit Conversion Engine**:
  - Base Unit (e.g. PCS, KG, BOX) aur Secondary Unit (e.g. DOZEN, GRAM, PACKET).
  - Conversion Rules: $1 \text{ BOX} = 24 \text{ PCS}$, $1 \text{ DAY} = 24 \text{ HOURS}$.
- **Item Categorization & Attributes**:
  - Item Name, Item Code / Barcode, Category (e.g., Keyboards, FMCG), Brand.
  - HSN/SAC Code, GST Tax Rate (Exempt, 0%, 5%, 12%, 18%, 28%, Cess).
  - Pricing: Purchase Price, Sale Price, MRP (Tax Inclusive vs Tax Exclusive option).
  - Stock Settings: Opening Stock Quantity, Minimum Low-Stock Alert Threshold, Rack/Storage Location.
- **Advanced Inventory Tracking Options**:
  - **Batch & Expiry Management**: Batch Number, Manufacturing Date, Expiry Date. Software automated Expiring Stock Alerts render karta hai.
  - **Serial Number / IMEI Tracking**: Har individual unit ke liye unique serial number or IMEI number tracking (Electronics/Mobiles ke liye).
  - **Variant Matrix**: Size, Color, MRP variations (Garments/Footwear ke liye).
  - **Stock Adjustments & Damaged Goods**: Stock damage, theft, expiry, ya promotional samples ke roop mein stock kam/badhane ki direct accounting entry.
  - **Barcode Generator & Scanner Integration**: Checkout screen par fast POS scanning aur custom barcode sticker printing support.

### Module 4: Transaction Engine & Document Flows
Vyapar ka transaction engine complete document lifecycle support karta hai:

#### A. Sales Lifecycle Flow
1. **Estimate / Quotation** $\rightarrow$ **Sales Order** $\rightarrow$ **Delivery Challan** $\rightarrow$ **Sales Invoice (Tax Invoice)** $\rightarrow$ **Payment In**.
2. **Auto-Conversion Logic**: Estimate se Sales Order, Order se Delivery Challan, aur Delivery Challan se Sales Invoice mein single click conversion. Conversion ke waqt stock deduction final Sales Invoice / Delivery Challan level par trigger hoti hai (Estimate/Order par stock deduct nahi hota).
3. **Sales Return / Credit Note**: Jab customer goods return karta hai, tab inventory stock wapas badhta hai (+ Stock), aur customer account credit hota hai.

#### B. Purchase Lifecycle Flow
1. **Purchase Order** $\rightarrow$ **Purchase Invoice** $\rightarrow$ **Purchase Return (Debit Note)** $\rightarrow$ **Payment Out**.
2. **ITC Tracking**: Input Tax Credit eligibility (Eligible vs Ineligible ITC) record ki jaati hai.
3. **Purchase Bill Number**: Supplier ke original physical bill number ko system mein link karke store kiya jata hai.

#### C. Invoicing Customizations & Custom Fields
- **Custom Fields**: Vehicle Number, Driver Phone, PO Number, Transport Name, E-Way Bill Number.
- **Billing Name vs Party Name**: Billing Name invoice par print karne ke liye aur Party Name internal ledger account ke liye.

### Module 5: Liquidity, Expense, Loans & Banking Engine
- **Cash in Hand Engine**: Initial business capital injection, cash adjustments, daily cash balance ledger.
- **Bank Account Engine**: Multi-bank account setup, online payment QR display on bills, bank statement reconciliation.
- **Contra Vouchers (Cash/Bank Transfers)**:
  - Cash Deposit to Bank Account.
  - Cash Withdrawal from Bank Account.
  - Bank A to Bank B Transfer.
- **Loan Account & EMI Mechanics**:
  - Principal Amount, Interest Rate, Processing Fee tracking.
  - EMI Payment Entry Split: Principal deduction (reduces Loan Liability) + Interest/Processing Fee allocation (recorded as Expense in P&L).
- **Expense Module**: Direct Expenses (Freight, Raw Material Transport) & Indirect Expenses (Rent, Salary, Tea/Tiffin, Electricity).

---

## 3. Screen-by-Screen & Button-by-Button Navigation Guide

1. **Company Profile & Logo Setup**:
   - **Path**: Top Toolbar `Company Dropdown` $\rightarrow$ Click `Change Company` $\rightarrow$ Click `+ Create New Company`.
   - **Details**: Business Name, Mobile Number, GSTIN. Profile update: Sidebar `Settings` $\rightarrow$ `Company Profile` $\rightarrow$ Click `+ Add Logo` & `+ Add Signature` $\rightarrow$ Click **Save**.
2. **Bank Account & Cash In Hand (Capital) Setup**:
   - **Bank Add Path**: Sidebar `Cash & Bank` $\rightarrow$ `Bank Accounts` $\rightarrow$ Click `+ Add Bank Account` (Green Button).
   - **Details**: Display Name, Opening Balance, enable checkbox `Print Bank Details on Invoice` (Account No, IFSC, UPI QR Code) $\rightarrow$ Click **Save**.
   - **Cash Injection Path**: Sidebar `Cash & Bank` $\rightarrow$ `Cash In Hand` $\rightarrow$ Click `Adjust Cash` $\rightarrow$ Select `Add Cash` $\rightarrow$ Enter Amount & Category (`Capital/Asset`) $\rightarrow$ Click **Save**.
3. **Item Master Creation (Inventory)**:
   - **Path**: Sidebar `Items` $\rightarrow$ Top-Right `+ Add Item` green button.
   - **Tabs & Fields**:
     - *Basic Details*: Name, Type (Product/Service), Barcode, Category (`+ Add Category`), Unit (`PCS`/`BOX`).
     - *Pricing*: Sales Price, Purchase Price, GST Rate %, HSN Code.
     - *Stock*: Opening Stock, Min Stock Alert Threshold, Rack/Storage Location $\rightarrow$ Click **Save**.
4. **Party Master Setup (Customer / Supplier)**:
   - **Path**: Sidebar `Parties` $\rightarrow$ Top-Right `+ Add Party` green button.
   - **Tabs & Fields**: Name, Phone, GST Type (Registered/Unregistered), GSTIN, Billing Address, Opening Balance (To Receive / To Pay), Credit Limit Amount & Days $\rightarrow$ Click **Save**.
5. **Purchase Entry & Stock Inward**:
   - **Path**: Dashboard `+ Add Purchase` OR Sidebar `Purchase` $\rightarrow$ `Purchase Bills` $\rightarrow$ Click `+ Add Purchase`.
   - **Fields**: Select Supplier Name, Input Supplier Bill Number, Add Items & Quantity, Fill Paid Amount (Cash/Bank) $\rightarrow$ Press `Ctrl + S` or click **Save**.
6. **Sales Invoicing & Billing**:
   - **Path**: Press `Alt + S` OR Dashboard `+ Add Sale` OR Sidebar `Sale` $\rightarrow$ Click `+ Add Sale`.
   - **Fields**: Select Customer (or Cash Sale), Select Items/Qty, Apply Discount %, Check GST Split (CGST+SGST / IGST), Enter Received Amount $\rightarrow$ Click **Save & Print**.
7. **Dues Settlement (Payment In & Payment Out)**:
   - **Customer Collection (Payment In)**: Sidebar `Sale` $\rightarrow$ `Payment In` $\rightarrow$ Click `+ Add Payment In`. Select Customer, enter received amount, tick pending invoice checkbox to link $\rightarrow$ Click **Save**.
   - **Supplier Payment (Payment Out)**: Sidebar `Purchase` $\rightarrow$ `Payment Out` $\rightarrow$ Click `+ Add Payment Out`. Select Supplier, Bank/Cash, enter amount $\rightarrow$ Click **Save**.
8. **Contra Entry (Cash-Bank Transfer)**:
   - **Path**: Sidebar `Cash & Bank` $\rightarrow$ Click `Contra Entry` $\rightarrow$ Choose Type (`Cash Deposit` or `Cash Withdrawal`) $\rightarrow$ Enter Amount & Select Bank $\rightarrow$ Click **Save**.
9. **Loan Entry & EMI Repayment**:
   - **Path**: Sidebar `Cash & Bank` $\rightarrow$ `Loan Accounts` $\rightarrow$ Click `+ Add Loan Account`.
   - **EMI Payment**: Select Loan $\rightarrow$ Click `Make EMI Payment` $\rightarrow$ Enter Principal & Interest Amount split $\rightarrow$ Click **Save**.
10. **Stock Adjustments & Damaged Goods**:
    - **Path**: Sidebar `Items` $\rightarrow$ Select Item $\rightarrow$ Click `Adjust Stock` $\rightarrow$ Choose `Reduce Quantity` $\rightarrow$ Select Reason (`Damaged` / `Expired`) $\rightarrow$ Click **Save**.

---

## 4. Master Mathematical & Ledger Matrix

| Transaction Type | Inventory Stock | Cash / Bank Balance | Party Ledger Balance | Financial Statement Impact |
| :--- | :--- | :--- | :--- | :--- |
| **Purchase Invoice** | $+ \text{Stock Quantity}$ | $- \text{Paid Amount}$ | $+ \text{Payable Due}$ | Increases Stock Asset, Increases Payable Liability |
| **Sales Invoice** | $- \text{Stock Quantity}$ | $+ \text{Received Amount}$ | $+ \text{Receivable Due}$ | Increases Sales Revenue, Increases Cash/Receivable Asset |
| **Payment Out** | No Impact | $- \text{Cash/Bank}$ | $- \text{Payable Due}$ | Decreases Bank Asset, Decreases Payable Liability |
| **Payment In** | No Impact | $+ \text{Cash/Bank}$ | $- \text{Receivable Due}$ | Reclassifies Receivable Asset into Cash Asset |
| **Expense Entry** | No Impact | $- \text{Cash/Bank}$ | No Impact | Decreases Net Income (P&L Expense) |
| **Contra (Cash Deposit)**| No Impact | Cash $-$, Bank $+$ | No Impact | Asset Reclassification (Cash $\rightarrow$ Bank) |
| **Loan EMI Payment** | No Impact | $- \text{Cash/Bank}$ | No Impact | Decreases Loan Liability (Principal) + Decreases P&L (Interest) |
| **Stock Damage Adjust** | $- \text{Stock Quantity}$ | No Impact | No Impact | Decreases Inventory Asset, Increases Expense/Loss |

---

## 5. Core Accounting Equations

1. **Gross Profit**:
   $$\text{Gross Profit} = \text{Total Sales Revenue} - \text{COGS} + \text{Stock Adjustments}$$
   $$\text{COGS (Cost of Goods Sold)} = \text{Opening Stock} + \text{Purchases} - \text{Closing Stock}$$
2. **Net Profit**:
   $$\text{Net Profit} = \text{Gross Profit} - \text{Total Operating Expenses} - \text{Loan Interest \& Processing Fees}$$
3. **Balance Sheet Balance**:
   $$\text{Total Assets (Cash + Bank + Receivables + Stock)} = \text{Total Liabilities (Payables + Loans)} + \text{Owner's Equity}$$

---
*Grounded in 9 Official Vyapar App Desktop Video Demo Series & Technical Documentation.*
