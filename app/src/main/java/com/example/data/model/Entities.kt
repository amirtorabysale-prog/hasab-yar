package com.example.data.model

import androidx.room.Entity
import androidx.room.PrimaryKey

enum class DocumentType(val titleFa: String) {
    PURCHASE("فاکتور خرید"),
    SALE("فاکتور فروش"),
    EXPENSE("هزینه جاری"),
    INCOME("درآمد و فروش خدمت"),
    RECEIPT("رسید دریافت"),
    PAYMENT("رسید پرداخت")
}

enum class DocumentStatus(val titleFa: String) {
    DRAFT("پیش‌نویس"),
    NEEDS_REVIEW("نیازمند بررسی"),
    APPROVED("تأییدشده"),
    EXPORTED("ثبت در سیستم مالی"),
    REJECTED("ردشده")
}

enum class DocumentSource(val titleFa: String) {
    VOICE("ورود صوتی هوشمند"),
    OCR("اسکن تصویر و فاکتور"),
    VOICE_OCR("ترکیبی (صوت + OCR)"),
    MANUAL("ورود دستی"),
    IMPORT("ورودی اکسل")
}

enum class TransactionType(val titleFa: String) {
    EXPENSE("هزینه و پرداخت"),
    RECEIVE("دریافت و واریز"),
    PURCHASE("خرید کالا"),
    SALE("فروش"),
    INCOME("درآمد"),
    TRANSFER("انتقال داخلی")
}

enum class ContactType(val titleFa: String) {
    VENDOR("فروشنده / تامین‌کننده"),
    CUSTOMER("مشتری / خریدار"),
    CONTRACTOR("پیمانکار"),
    EMPLOYEE("پرسنل / کارمند")
}

enum class UserRole(val titleFa: String) {
    OWNER("مدیرعامل / مالک"),
    FINANCIAL_MANAGER("مدیر مالی"),
    SENIOR_ACCOUNTANT("حسابدار ارشد"),
    OPERATOR("اپراتور حسابداری"),
    AUDITOR("حسابرس مستقل")
}

enum class AccountPlan(val titleFa: String, val monthlyDocsLimit: Int, val maxCompanies: Int) {
    PRO("نسخه نامحدود Pro", 10000, 10),
    STARTER("پلن مقدماتی استارتر", 200, 2),
    LITE("پلن تک‌کاربره لایت", 50, 1)
}

@Entity(tableName = "companies")
data class CompanyEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val name: String,
    val activityType: String,
    val nationalId: String = "",
    val currency: String = "تومان",
    val city: String = "تهران",
    val description: String = ""
)

@Entity(tableName = "contacts")
data class ContactEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val companyId: Long,
    val name: String,
    val phone: String = "",
    val type: ContactType = ContactType.VENDOR,
    val balance: Long = 0L,
    val notes: String = ""
)

@Entity(tableName = "categories")
data class CategoryEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val companyId: Long,
    val name: String,
    val type: String = "هزینه",
    val iconName: String = "category"
)

@Entity(tableName = "documents")
data class DocumentEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val companyId: Long,
    val type: DocumentType = DocumentType.PURCHASE,
    val contactName: String = "",
    val invoiceNumber: String = "",
    val dateShamsi: String = "",
    val subtotal: Long = 0L,
    val tax: Long = 0L,
    val discount: Long = 0L,
    val total: Long = 0L,
    val description: String = "",
    val categoryName: String = "",
    val paymentMethod: String = "نقدی / حواله",
    val status: DocumentStatus = DocumentStatus.NEEDS_REVIEW,
    val source: DocumentSource = DocumentSource.VOICE,
    val confidenceScore: Float = 0.90f,
    val rawTranscript: String? = null,
    val fileUrl: String? = null,
    val createdBy: String = "امیرحسین (اپراتور ارشد)",
    val createdAt: Long = System.currentTimeMillis()
)

@Entity(tableName = "transactions")
data class TransactionEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val companyId: Long,
    val type: TransactionType = TransactionType.EXPENSE,
    val amount: Long = 0L,
    val dateShamsi: String = "",
    val contactName: String = "",
    val categoryName: String = "",
    val description: String = "",
    val bankAccountId: Long? = null,
    val documentId: Long? = null,
    val createdAt: Long = System.currentTimeMillis()
)

@Entity(tableName = "bank_accounts")
data class BankAccountEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val companyId: Long,
    val bankName: String,
    val accountName: String,
    val accountNumber: String,
    val cardNumber: String = "",
    val currentBalance: Long = 0L
)

@Entity(tableName = "bank_transactions")
data class BankTransactionEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val companyId: Long,
    val bankAccountId: Long,
    val dateShamsi: String,
    val description: String,
    val debit: Long = 0L,
    val credit: Long = 0L,
    val balance: Long = 0L,
    val isReconciled: Boolean = false,
    val matchedDocumentId: Long? = null
)

@Entity(tableName = "accounting_rules")
data class AccountingRuleEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val companyId: Long,
    val keyword: String,
    val suggestedCategoryName: String
)

@Entity(tableName = "audit_logs")
data class AuditLogEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val companyId: Long,
    val documentId: Long,
    val action: String,
    val detail: String,
    val userName: String = "امیرحسین (اپراتور ارشد)",
    val timestamp: Long = System.currentTimeMillis()
)
