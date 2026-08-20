package com.example.data.repository

import com.example.data.db.AppDao
import com.example.data.db.AppDatabase
import com.example.data.model.AccountPlan
import com.example.data.model.AccountingRuleEntity
import com.example.data.model.AuditLogEntity
import com.example.data.model.BankAccountEntity
import com.example.data.model.BankTransactionEntity
import com.example.data.model.CategoryEntity
import com.example.data.model.CompanyEntity
import com.example.data.model.ContactEntity
import com.example.data.model.ContactType
import com.example.data.model.DocumentEntity
import com.example.data.model.DocumentSource
import com.example.data.model.DocumentStatus
import com.example.data.model.DocumentType
import com.example.data.model.TransactionEntity
import com.example.data.model.TransactionType
import com.example.data.model.UserRole
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.launch

class AccountingRepository(private val db: AppDatabase) {

    private val dao: AppDao = db.appDao()
    private val scope = CoroutineScope(Dispatchers.IO)

    val allCompanies: Flow<List<CompanyEntity>> = dao.getAllCompanies()

    private val _activeCompanyId = MutableStateFlow<Long>(1L)
    val activeCompanyId: StateFlow<Long> = _activeCompanyId.asStateFlow()

    init {
        scope.launch {
            seedInitialDataIfNeeded()
        }
    }

    fun setActiveCompanyId(id: Long) {
        _activeCompanyId.value = id
    }

    val documents: Flow<List<DocumentEntity>> = _activeCompanyId.flatMapLatest { companyId ->
        dao.getDocuments(companyId)
    }

    val transactions: Flow<List<TransactionEntity>> = _activeCompanyId.flatMapLatest { companyId ->
        dao.getTransactions(companyId)
    }

    val contacts: Flow<List<ContactEntity>> = _activeCompanyId.flatMapLatest { companyId ->
        dao.getContacts(companyId)
    }

    val categories: Flow<List<CategoryEntity>> = _activeCompanyId.flatMapLatest { companyId ->
        dao.getCategories(companyId)
    }

    val bankAccounts: Flow<List<BankAccountEntity>> = _activeCompanyId.flatMapLatest { companyId ->
        dao.getBankAccounts(companyId)
    }

    val bankTransactions: Flow<List<BankTransactionEntity>> = _activeCompanyId.flatMapLatest { companyId ->
        dao.getBankTransactions(companyId)
    }

    val rules: Flow<List<AccountingRuleEntity>> = _activeCompanyId.flatMapLatest { companyId ->
        dao.getRules(companyId)
    }

    fun getAuditLogs(documentId: Long): Flow<List<AuditLogEntity>> {
        return dao.getAuditLogsForDocument(documentId)
    }

    suspend fun saveDocument(doc: DocumentEntity, auditNote: String = "ایجاد سند جدید"): Long {
        val insertedId = dao.insertDocument(doc)
        val docId = if (doc.id > 0) doc.id else insertedId

        dao.insertAuditLog(
            AuditLogEntity(
                companyId = doc.companyId,
                documentId = docId,
                action = if (doc.status == DocumentStatus.APPROVED) "تأیید نهایی و ثبت" else "ایجاد سند",
                detail = auditNote
            )
        )

        // If approved, automatically create a linked transaction
        if (doc.status == DocumentStatus.APPROVED && doc.total > 0) {
            val transType = when (doc.type) {
                DocumentType.PURCHASE -> TransactionType.PURCHASE
                DocumentType.SALE -> TransactionType.SALE
                DocumentType.EXPENSE -> TransactionType.EXPENSE
                DocumentType.INCOME -> TransactionType.INCOME
                DocumentType.RECEIPT -> TransactionType.RECEIVE
                DocumentType.PAYMENT -> TransactionType.EXPENSE
            }
            dao.insertTransaction(
                TransactionEntity(
                    companyId = doc.companyId,
                    type = transType,
                    amount = doc.total,
                    dateShamsi = doc.dateShamsi,
                    contactName = doc.contactName,
                    categoryName = doc.categoryName,
                    description = "ثبت خودکار از سند شماره ${doc.invoiceNumber}: ${doc.description}",
                    documentId = docId
                )
            )
        }

        return docId
    }

    suspend fun updateDocumentStatus(documentId: Long, newStatus: DocumentStatus, note: String = "") {
        val doc = dao.getDocumentById(documentId) ?: return
        val updated = doc.copy(status = newStatus)
        dao.updateDocument(updated)
        dao.insertAuditLog(
            AuditLogEntity(
                companyId = doc.companyId,
                documentId = doc.id,
                action = "تغییر وضعیت به ${newStatus.titleFa}",
                detail = note.ifBlank { "وضعیت سند توسط اپراتور به‌روزرسانی شد." }
            )
        )
    }

    suspend fun findDuplicates(companyId: Long, invoiceNumber: String, contactName: String): List<DocumentEntity> {
        if (invoiceNumber.isBlank() || contactName.isBlank()) return emptyList()
        return dao.findDuplicates(companyId, invoiceNumber, contactName)
    }

    suspend fun addTransaction(tx: TransactionEntity): Long = dao.insertTransaction(tx)

    suspend fun addContact(contact: ContactEntity): Long = dao.insertContact(contact)

    suspend fun addCompany(company: CompanyEntity): Long = dao.insertCompany(company)

    suspend fun addRule(rule: AccountingRuleEntity): Long = dao.insertRule(rule)

    suspend fun reconcileBank(bankTransId: Long, documentId: Long) {
        val trans = dao.getBankTransactions(_activeCompanyId.value)
        // update reconciliation flag
    }

    private suspend fun seedInitialDataIfNeeded() {
        val comp1 = CompanyEntity(
            id = 1,
            name = "شرکت پارس تجارت",
            activityType = "بازرگانی و واردات",
            nationalId = "10108877665",
            currency = "تومان",
            city = "تهران",
            description = "شرکت اصلی بازرگانی قطعات الکترونیکی و IT"
        )
        val comp2 = CompanyEntity(
            id = 2,
            name = "شرکت نوین صنعت",
            activityType = "تولیدی و صنعتی",
            nationalId = "10103344556",
            currency = "تومان",
            city = "اصفهان",
            description = "تولید و مونتاژ تجهیزات مخابراتی"
        )
        val comp3 = CompanyEntity(
            id = 3,
            name = "فروشگاه دیجیتال آرمان",
            activityType = "خرده‌فروشی",
            nationalId = "10109988771",
            currency = "تومان",
            city = "شیراز",
            description = "فروشگاه آنلاین و حضوری"
        )
        dao.insertCompanies(listOf(comp1, comp2, comp3))

        // Categories
        val cats = listOf(
            CategoryEntity(id = 1, companyId = 1, name = "خرید کالا و تجهیزات", type = "هزینه"),
            CategoryEntity(id = 2, companyId = 1, name = "فروش محصولات", type = "درآمد"),
            CategoryEntity(id = 3, companyId = 1, name = "تجهیزات اداری و ملزومات", type = "هزینه"),
            CategoryEntity(id = 4, companyId = 1, name = "اینترنت و ارتباطات", type = "هزینه"),
            CategoryEntity(id = 5, companyId = 1, name = "حمل و نقل و ارسال", type = "هزینه"),
            CategoryEntity(id = 6, companyId = 1, name = "هزینه سوخت و بنزین", type = "هزینه"),
            CategoryEntity(id = 7, companyId = 1, name = "تبلیغات و بازاریابی", type = "هزینه"),
            CategoryEntity(id = 8, companyId = 1, name = "حق‌التحریر و ثبت اداری", type = "هزینه")
        )
        dao.insertCategories(cats)

        // Contacts
        val contacts = listOf(
            ContactEntity(id = 1, companyId = 1, name = "شرکت پارس رایانه", phone = "021-88776655", type = ContactType.VENDOR, balance = 132000000L, notes = "تأمین‌کننده لپ‌تاپ و سرور"),
            ContactEntity(id = 2, companyId = 1, name = "شرکت نوین تجارت", phone = "021-22334455", type = ContactType.VENDOR, balance = 80000000L, notes = "مبلمان اداری و دکوراسیون"),
            ContactEntity(id = 3, companyId = 1, name = "فروشگاه آرمان", phone = "071-36221144", type = ContactType.CUSTOMER, balance = -45000000L, notes = "مشتری عمده لوازم جانبی"),
            ContactEntity(id = 4, companyId = 1, name = "ایرانسل", phone = "09350000000", type = ContactType.VENDOR, balance = 0L, notes = "اینترنت فیبر نوری سازمانی"),
            ContactEntity(id = 5, companyId = 1, name = "شرکت حمل و نقل پیشتاز", phone = "021-66554433", type = ContactType.VENDOR, balance = 4500000L, notes = "ارسال بار و محموله‌ها")
        )
        dao.insertContacts(contacts)

        // Rules
        val rules = listOf(
            AccountingRuleEntity(id = 1, companyId = 1, keyword = "ایرانسل", suggestedCategoryName = "اینترنت و ارتباطات"),
            AccountingRuleEntity(id = 2, companyId = 1, keyword = "اسنپ", suggestedCategoryName = "حمل و نقل و ارسال"),
            AccountingRuleEntity(id = 3, companyId = 1, keyword = "دیجی‌کالا", suggestedCategoryName = "تجهیزات اداری و ملزومات"),
            AccountingRuleEntity(id = 4, companyId = 1, keyword = "بنزین", suggestedCategoryName = "هزینه سوخت و بنزین")
        )
        dao.insertRules(rules)

        // Bank Accounts
        val bankAccounts = listOf(
            BankAccountEntity(id = 1, companyId = 1, bankName = "بانک ملت", accountName = "حساب جاری بازرگانی", accountNumber = "4512-8877-0091", cardNumber = "6104-3378-9900-1122", currentBalance = 485000000L),
            BankAccountEntity(id = 2, companyId = 1, bankName = "بانک سامان", accountName = "حساب پشتیبان ریالی", accountNumber = "8890-1122-3344", cardNumber = "6219-8610-4455-6677", currentBalance = 120000000L)
        )
        dao.insertBankAccounts(bankAccounts)

        // Documents
        val baseTime = System.currentTimeMillis() - 86400000L * 5
        val docs = listOf(
            DocumentEntity(
                id = 1,
                companyId = 1,
                type = DocumentType.PURCHASE,
                contactName = "شرکت پارس رایانه",
                invoiceNumber = "1245",
                dateShamsi = "1405/05/28",
                subtotal = 120000000L,
                tax = 12000000L,
                discount = 0L,
                total = 132000000L,
                description = "خرید ۲ دستگاه لپ‌تاپ لنوو تینک‌پد و تجهیزات",
                categoryName = "خرید کالا و تجهیزات",
                paymentMethod = "حواله پایا",
                status = DocumentStatus.APPROVED,
                source = DocumentSource.VOICE,
                confidenceScore = 0.98f,
                rawTranscript = "فاکتور خرید از شرکت پارس رایانه، تاریخ بیست و هشت مرداد هزار و چهارصد و پنج، شماره فاکتور ۱۲۴۵، مبلغ قبل مالیات صد و بیست میلیون تومان، مالیات دوازده میلیون، جمع صد و سی و دو میلیون، بابت خرید دو دستگاه لپتاپ.",
                createdAt = baseTime + 100000L
            ),
            DocumentEntity(
                id = 2,
                companyId = 1,
                type = DocumentType.PURCHASE,
                contactName = "شرکت نوین تجارت",
                invoiceNumber = "8841",
                dateShamsi = "1405/05/20",
                subtotal = 80000000L,
                tax = 0L,
                discount = 0L,
                total = 80000000L,
                description = "خرید میز و صندلی ارگونومیک مدیریت",
                categoryName = "تجهیزات اداری و ملزومات",
                paymentMethod = "چک صیادی",
                status = DocumentStatus.APPROVED,
                source = DocumentSource.VOICE,
                confidenceScore = 0.94f,
                rawTranscript = "فاکتور خرید از شرکت نوین تجارت مبلغ هشتاد میلیون تومان تاریخ بیست مرداد بابت خرید تجهیزات اداری.",
                createdAt = baseTime + 200000L
            ),
            DocumentEntity(
                id = 3,
                companyId = 1,
                type = DocumentType.EXPENSE,
                contactName = "ایرانسل",
                invoiceNumber = "IR-9042",
                dateShamsi = "1405/05/25",
                subtotal = 3800000L,
                tax = 380000L,
                discount = 0L,
                total = 4180000L,
                description = "اشتراک پهنای باند اختصاصی فیبر نوری مرداد ماه",
                categoryName = "اینترنت و ارتباطات",
                paymentMethod = "کارت به کارت",
                status = DocumentStatus.EXPORTED,
                source = DocumentSource.OCR,
                confidenceScore = 0.96f,
                createdAt = baseTime + 300000L
            ),
            DocumentEntity(
                id = 4,
                companyId = 1,
                type = DocumentType.SALE,
                contactName = "فروشگاه آرمان",
                invoiceNumber = "INV-7701",
                dateShamsi = "1405/05/27",
                subtotal = 145000000L,
                tax = 14500000L,
                discount = 4500000L,
                total = 155000000L,
                description = "فروش عمده مانیتور و تجهیزات جانبی",
                categoryName = "فروش محصولات",
                paymentMethod = "واریز به حساب",
                status = DocumentStatus.APPROVED,
                source = DocumentSource.VOICE_OCR,
                confidenceScore = 0.92f,
                createdAt = baseTime + 400000L
            ),
            DocumentEntity(
                id = 5,
                companyId = 1,
                type = DocumentType.EXPENSE,
                contactName = "شرکت حمل و نقل پیشتاز",
                invoiceNumber = "BAR-551",
                dateShamsi = "1405/05/26",
                subtotal = 4500000L,
                tax = 0L,
                discount = 0L,
                total = 4500000L,
                description = "کرایه حمل بار محموله شیراز",
                categoryName = "حمل و نقل و ارسال",
                paymentMethod = "نقدی",
                status = DocumentStatus.NEEDS_REVIEW,
                source = DocumentSource.VOICE,
                confidenceScore = 0.72f,
                createdAt = baseTime + 500000L
            ),
            DocumentEntity(
                id = 6,
                companyId = 1,
                type = DocumentType.EXPENSE,
                contactName = "",
                invoiceNumber = "GAS-102",
                dateShamsi = "1405/05/28",
                subtotal = 450000L,
                tax = 0L,
                discount = 0L,
                total = 450000L,
                description = "هزینه بنزین خودروی شرکت - بدون نام طرف حساب",
                categoryName = "هزینه سوخت و بنزین",
                paymentMethod = "کارتخوان",
                status = DocumentStatus.NEEDS_REVIEW,
                source = DocumentSource.VOICE,
                confidenceScore = 0.65f,
                createdAt = baseTime + 600000L
            ),
            DocumentEntity(
                id = 7,
                companyId = 1,
                type = DocumentType.PURCHASE,
                contactName = "شرکت پارس رایانه",
                invoiceNumber = "1290",
                dateShamsi = "1405/05/29",
                subtotal = 45000000L,
                tax = 5000000L,
                discount = 0L,
                total = 52000000L,
                description = "خرید کابل‌های شبکه و سوئیچ سیسکو (دارای اختلاف جمع)",
                categoryName = "خرید کالا و تجهیزات",
                paymentMethod = "حواله",
                status = DocumentStatus.NEEDS_REVIEW,
                source = DocumentSource.VOICE,
                confidenceScore = 0.68f,
                createdAt = baseTime + 700000L
            )
        )
        dao.insertDocuments(docs)

        // Initial Audit Log
        dao.insertAuditLog(
            AuditLogEntity(
                companyId = 1,
                documentId = 1,
                action = "ایجاد سند",
                detail = "ثبت صوتی اولیه با هوش مصنوعی و تطبیق الگوریتمی با موفقیت انجام شد."
            )
        )

        // Initial Bank Transactions
        val bTrans = listOf(
            BankTransactionEntity(
                id = 1,
                companyId = 1,
                bankAccountId = 1,
                dateShamsi = "1405/05/28",
                description = "پایا به شرکت پارس رایانه بابت فاکتور ۱۲۴۵",
                debit = 132000000L,
                credit = 0L,
                balance = 485000000L,
                isReconciled = true,
                matchedDocumentId = 1
            ),
            BankTransactionEntity(
                id = 2,
                companyId = 1,
                bankAccountId = 1,
                dateShamsi = "1405/05/27",
                description = "واریز ساتنا از فروشگاه آرمان",
                debit = 0L,
                credit = 155000000L,
                balance = 617000000L,
                isReconciled = false,
                matchedDocumentId = 4
            )
        )
        dao.insertBankTransactions(bTrans)

        // Initial Transactions
        val trans = listOf(
            TransactionEntity(
                id = 1,
                companyId = 1,
                type = TransactionType.PURCHASE,
                amount = 132000000L,
                dateShamsi = "1405/05/28",
                contactName = "شرکت پارس رایانه",
                categoryName = "خرید کالا و تجهیزات",
                description = "پرداخت وجه فاکتور ۱۲۴۵ خرید لپ‌تاپ",
                documentId = 1
            ),
            TransactionEntity(
                id = 2,
                companyId = 1,
                type = TransactionType.SALE,
                amount = 155000000L,
                dateShamsi = "1405/05/27",
                contactName = "فروشگاه آرمان",
                categoryName = "فروش محصولات",
                description = "دریافت وجه فروش مانیتورها",
                documentId = 4
            )
        )
        dao.insertTransactions(trans)
    }
}
