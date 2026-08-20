package com.example.ui.viewmodel

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.example.ai.AIExtractionEngine
import com.example.ai.SpeechManager
import com.example.data.model.SpeechPreset
import com.example.ai.ValidationEngine
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
import com.example.data.model.FieldExtraction
import com.example.data.model.StructuredExtraction
import com.example.data.model.TransactionEntity
import com.example.data.model.TransactionType
import com.example.data.model.UserRole
import com.example.data.model.ValidationReport
import com.example.data.repository.AccountingRepository
import com.example.util.PersianUtils
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

data class ContinuousSessionStats(
    val totalProcessed: Int = 0,
    val approved: Int = 0,
    val needsReview: Int = 0,
    val avgSeconds: Int = 18
)

class HesabYarViewModel(application: Application) : AndroidViewModel(application) {

    private val db = AppDatabase.getInstance(application)
    val repository = AccountingRepository(db)
    val speechManager = SpeechManager(application)

    val allCompanies: StateFlow<List<CompanyEntity>> = repository.allCompanies
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    val activeCompanyId: StateFlow<Long> = repository.activeCompanyId

    val activeCompany: StateFlow<CompanyEntity?> = combine(allCompanies, activeCompanyId) { list, id ->
        list.firstOrNull { it.id == id } ?: list.firstOrNull()
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), null)

    val documents: StateFlow<List<DocumentEntity>> = repository.documents
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    val transactions: StateFlow<List<TransactionEntity>> = repository.transactions
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    val contacts: StateFlow<List<ContactEntity>> = repository.contacts
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    val categories: StateFlow<List<CategoryEntity>> = repository.categories
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    val bankAccounts: StateFlow<List<BankAccountEntity>> = repository.bankAccounts
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    val bankTransactions: StateFlow<List<BankTransactionEntity>> = repository.bankTransactions
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    val rules: StateFlow<List<AccountingRuleEntity>> = repository.rules
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    // App State
    private val _userRole = MutableStateFlow(UserRole.FINANCIAL_MANAGER)
    val userRole: StateFlow<UserRole> = _userRole.asStateFlow()

    private val _accountPlan = MutableStateFlow(AccountPlan.PRO)
    val accountPlan: StateFlow<AccountPlan> = _accountPlan.asStateFlow()

    private val _userName = MutableStateFlow("امیرحسین (اپراتور ارشد)")
    val userName: StateFlow<String> = _userName.asStateFlow()

    // Fast Entry & Continuous State
    private val _currentExtraction = MutableStateFlow(StructuredExtraction())
    val currentExtraction: StateFlow<StructuredExtraction> = _currentExtraction.asStateFlow()

    private val _isAnalyzing = MutableStateFlow(false)
    val isAnalyzing: StateFlow<Boolean> = _isAnalyzing.asStateFlow()

    private val _isContinuousMode = MutableStateFlow(false)
    val isContinuousMode: StateFlow<Boolean> = _isContinuousMode.asStateFlow()

    private val _continuousStats = MutableStateFlow(ContinuousSessionStats())
    val continuousStats: StateFlow<ContinuousSessionStats> = _continuousStats.asStateFlow()

    private val _validationReport = MutableStateFlow(ValidationReport())
    val validationReport: StateFlow<ValidationReport> = _validationReport.asStateFlow()

    private val _showDuplicateWarning = MutableStateFlow(false)
    val showDuplicateWarning: StateFlow<Boolean> = _showDuplicateWarning.asStateFlow()

    private val _ocrSamplePreview = MutableStateFlow<String?>(null)
    val ocrSamplePreview: StateFlow<String?> = _ocrSamplePreview.asStateFlow()

    private val _saveSuccessMessage = MutableStateFlow<String?>(null)
    val saveSuccessMessage: StateFlow<String?> = _saveSuccessMessage.asStateFlow()

    init {
        // Monitor speech manager transcript
        viewModelScope.launch {
            speechManager.transcript.collect { text ->
                if (text.isNotBlank()) {
                    runExtraction(text, DocumentSource.VOICE)
                }
            }
        }
    }

    fun switchCompany(companyId: Long) {
        repository.setActiveCompanyId(companyId)
    }

    fun setUserRole(role: UserRole) {
        _userRole.value = role
    }

    fun setAccountPlan(plan: AccountPlan) {
        _accountPlan.value = plan
    }

    fun startVoiceRecording() {
        speechManager.startListening()
    }

    fun stopVoiceRecording() {
        speechManager.stopListening()
    }

    fun toggleContinuousMode() {
        _isContinuousMode.value = !_isContinuousMode.value
    }

    fun setOcrPreview(sampleName: String) {
        _ocrSamplePreview.value = sampleName
        val transcript = when (sampleName) {
            "فاکتور رسمی پارس رایانه" -> "فاکتور فروش شماره IR-1245، فروشنده شرکت پارس رایانه، خریدار شرکت پارس تجارت، تاریخ ۱۴۰۵/۰۵/۲۸، مبلغ جزء ۱۲۰،۰۰۰،۰۰۰ ریال/تومان، مالیات ۱۲،۰۰۰،۰۰۰ تومان، جمع کل ۱۳۲،۰۰۰،۰۰۰ تومان."
            "رسید پوز رستوران / سوخت" -> "رسید پرداخت الکترونیک، تاریخ ۱۴۰۵/۰۵/۲۸، مبلغ ۴۵۰،۰۰۰ تومان، بابت هزینه سوخت و بنزین."
            else -> "فاکتور خرید تجهیزات اداری از شرکت نوین تجارت مبلغ ۸۰،۰۰۰،۰۰۰ تومان تاریخ ۱۴۰۵/۰۵/۲۰."
        }
        runExtraction(transcript, DocumentSource.OCR)
    }

    fun clearOcrPreview() {
        _ocrSamplePreview.value = null
    }

    fun processPresetSpeech(preset: SpeechPreset) {
        speechManager.setManualTranscript(preset.transcript)
        runExtraction(preset.transcript, DocumentSource.VOICE)
    }

    fun processCustomTranscript(text: String, source: DocumentSource = DocumentSource.VOICE) {
        runExtraction(text, source)
    }

    private fun runExtraction(transcript: String, source: DocumentSource) {
        viewModelScope.launch {
            _isAnalyzing.value = true
            val currentContacts = contacts.value
            val currentCats = categories.value
            val currentRules = rules.value

            val ext = AIExtractionEngine.extractFromTranscript(
                transcript = transcript,
                source = source,
                knownContacts = currentContacts,
                knownCategories = currentCats,
                rules = currentRules
            )
            _currentExtraction.value = ext

            // Check duplicates
            val compId = activeCompanyId.value
            val invNum = ext.invoiceNumber.value ?: ""
            val contactN = ext.contactName.value ?: ""
            val dups = repository.findDuplicates(compId, invNum, contactN)
            _showDuplicateWarning.value = dups.isNotEmpty()

            val report = ValidationEngine.validate(ext, dups)
            _validationReport.value = report

            _isAnalyzing.value = false
        }
    }

    fun updateField(fieldName: String, value: String) {
        val curr = _currentExtraction.value
        val updated = when (fieldName) {
            "contactName" -> curr.copy(contactName = curr.contactName.copy(value = value, isUserEdited = true, confidence = 1.0f))
            "invoiceNumber" -> curr.copy(invoiceNumber = curr.invoiceNumber.copy(value = value, isUserEdited = true, confidence = 1.0f))
            "dateShamsi" -> curr.copy(dateShamsi = curr.dateShamsi.copy(value = value, isUserEdited = true, confidence = 1.0f))
            "subtotal" -> {
                val num = PersianUtils.parsePersianAmount(value) ?: 0L
                curr.copy(subtotal = curr.subtotal.copy(value = num, isUserEdited = true, confidence = 1.0f))
            }
            "tax" -> {
                val num = PersianUtils.parsePersianAmount(value) ?: 0L
                curr.copy(tax = curr.tax.copy(value = num, isUserEdited = true, confidence = 1.0f))
            }
            "discount" -> {
                val num = PersianUtils.parsePersianAmount(value) ?: 0L
                curr.copy(discount = curr.discount.copy(value = num, isUserEdited = true, confidence = 1.0f))
            }
            "total" -> {
                val num = PersianUtils.parsePersianAmount(value) ?: 0L
                curr.copy(total = curr.total.copy(value = num, isUserEdited = true, confidence = 1.0f))
            }
            "description" -> curr.copy(description = curr.description.copy(value = value, isUserEdited = true, confidence = 1.0f))
            "categoryName" -> curr.copy(categoryName = curr.categoryName.copy(value = value, isUserEdited = true, confidence = 1.0f))
            "paymentMethod" -> curr.copy(paymentMethod = curr.paymentMethod.copy(value = value, isUserEdited = true, confidence = 1.0f))
            else -> curr
        }
        _currentExtraction.value = updated
        val report = ValidationEngine.validate(updated, emptyList())
        _validationReport.value = report
    }

    fun saveDocument(status: DocumentStatus, onSaved: (Long) -> Unit) {
        viewModelScope.launch {
            val ext = _currentExtraction.value
            val compId = activeCompanyId.value
            val todayShamsi = PersianUtils.getCurrentShamsiDate()

            val doc = DocumentEntity(
                companyId = compId,
                type = ext.documentType.value ?: DocumentType.PURCHASE,
                contactName = ext.contactName.value.orEmpty(),
                invoiceNumber = ext.invoiceNumber.value ?: "INV-${(1000..9999).random()}",
                dateShamsi = ext.dateShamsi.value ?: todayShamsi,
                subtotal = ext.subtotal.value ?: 0L,
                tax = ext.tax.value ?: 0L,
                discount = ext.discount.value ?: 0L,
                total = ext.total.value ?: 0L,
                description = ext.description.value ?: "ثبت فاکتور سریع",
                categoryName = ext.categoryName.value ?: "خرید کالا و تجهیزات",
                paymentMethod = ext.paymentMethod.value ?: "نقدی / حواله",
                status = status,
                source = ext.source,
                confidenceScore = _validationReport.value.overallConfidence,
                rawTranscript = ext.rawTranscript,
                createdBy = _userName.value
            )

            val savedId = repository.saveDocument(doc, "ثبت از طریق ماژول ورود سریع (${ext.source.titleFa})")
            _saveSuccessMessage.value = "سند با شماره فاکتور ${doc.invoiceNumber} با موفقیت ثبت گردید."

            // Update continuous stats
            val prev = _continuousStats.value
            _continuousStats.value = prev.copy(
                totalProcessed = prev.totalProcessed + 1,
                approved = if (status == DocumentStatus.APPROVED) prev.approved + 1 else prev.approved,
                needsReview = if (status == DocumentStatus.NEEDS_REVIEW) prev.needsReview + 1 else prev.needsReview
            )

            // Reset extraction
            _currentExtraction.value = StructuredExtraction()
            _ocrSamplePreview.value = null

            // If continuous mode, trigger next voice prompt
            if (_isContinuousMode.value) {
                speechManager.startListening()
            }

            onSaved(savedId)
        }
    }

    fun dismissSuccessMessage() {
        _saveSuccessMessage.value = null
    }

    fun updateDocumentStatus(documentId: Long, newStatus: DocumentStatus) {
        viewModelScope.launch {
            repository.updateDocumentStatus(documentId, newStatus)
        }
    }

    fun addTransaction(type: TransactionType, amount: Long, contact: String, desc: String, category: String) {
        viewModelScope.launch {
            val tx = TransactionEntity(
                companyId = activeCompanyId.value,
                type = type,
                amount = amount,
                dateShamsi = PersianUtils.getCurrentShamsiDate(),
                contactName = contact,
                categoryName = category,
                description = desc
            )
            repository.addTransaction(tx)
        }
    }

    fun addContact(name: String, phone: String, type: ContactType, notes: String) {
        viewModelScope.launch {
            val c = ContactEntity(
                companyId = activeCompanyId.value,
                name = name,
                phone = phone,
                type = type,
                notes = notes
            )
            repository.addContact(c)
        }
    }

    fun createCompany(name: String, activity: String, nationalId: String, city: String, desc: String) {
        viewModelScope.launch {
            val comp = CompanyEntity(
                name = name,
                activityType = activity,
                nationalId = nationalId,
                city = city,
                description = desc
            )
            val newId = repository.addCompany(comp)
            switchCompany(newId)
        }
    }

    fun addRule(keyword: String, suggestedCategoryName: String) {
        viewModelScope.launch {
            val rule = AccountingRuleEntity(
                companyId = activeCompanyId.value,
                keyword = keyword,
                suggestedCategoryName = suggestedCategoryName
            )
            repository.addRule(rule)
        }
    }

    fun reconcileBank(bankTransId: Long, documentId: Long) {
        viewModelScope.launch {
            repository.reconcileBank(bankTransId, documentId)
        }
    }
}
