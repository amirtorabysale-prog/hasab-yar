package com.example.ai

import com.example.data.model.AccountingRuleEntity
import com.example.data.model.CategoryEntity
import com.example.data.model.ContactEntity
import com.example.data.model.DocumentSource
import com.example.data.model.DocumentType
import com.example.data.model.FieldExtraction
import com.example.data.model.StructuredExtraction
import com.example.util.PersianUtils

object AIExtractionEngine {

    fun extractFromTranscript(
        transcript: String,
        source: DocumentSource = DocumentSource.VOICE,
        knownContacts: List<ContactEntity> = emptyList(),
        knownCategories: List<CategoryEntity> = emptyList(),
        rules: List<AccountingRuleEntity> = emptyList()
    ): StructuredExtraction {
        val norm = transcript.trim()

        // 1. Detect Document Type
        val docType = when {
            norm.contains("فروش") || norm.contains("فروختیم") || norm.contains("ارائه خدمت") -> DocumentType.SALE
            norm.contains("هزینه") || norm.contains("قبض") || norm.contains("شارژ") || norm.contains("کرایه") || norm.contains("بنزین") -> DocumentType.EXPENSE
            norm.contains("درآمد") || norm.contains("واریزی") || norm.contains("دریافت") -> DocumentType.INCOME
            norm.contains("پرداخت") || norm.contains("تسویه") -> DocumentType.PAYMENT
            norm.contains("رسید") -> DocumentType.RECEIPT
            else -> DocumentType.PURCHASE
        }

        // 2. Extract Contact Name
        var contactMatch: String? = null
        var contactConfidence = 0.5f

        for (contact in knownContacts) {
            if (norm.contains(contact.name, ignoreCase = true)) {
                contactMatch = contact.name
                contactConfidence = 0.98f
                break
            }
        }
        if (contactMatch == null) {
            // Regex match for "از [نام]", "به [نام]", "شرکت [نام]", "فروشگاه [نام]"
            val contactRegex = Regex("(?:از|به|شرکت|فروشگاه|آقای|خانم)\\s+([\\u0600-\\u06FF\\s]+?)(?:،|\\s+تاریخ|\\s+مبلغ|\\s+شماره|\\s+بابت|$)")
            val match = contactRegex.find(norm)
            if (match != null && match.groupValues[1].isNotBlank()) {
                contactMatch = match.groupValues[1].trim()
                contactConfidence = 0.85f
            }
        }

        // 3. Extract Invoice Number
        val invoiceRegex = Regex("(?:شماره\\s+فاکتور|فاکتور\\s+شماره|شماره|سند)\\s*[:#-]?\\s*([A-Za-z0-9\\u06F0-\\u06F9\\-]+)")
        val invMatch = invoiceRegex.find(norm)
        val invoiceNumber = invMatch?.groupValues?.get(1)?.let { PersianUtils.toEnglishDigits(it) }

        // 4. Extract Date
        val dateShamsi = PersianUtils.extractShamsiDate(norm)

        // 5. Extract Amounts
        val totalAmount = PersianUtils.extractAmount(norm) ?: 0L
        var subtotal = totalAmount
        var tax = 0L
        var discount = 0L

        // Check if tax mentioned
        if (norm.contains("مالیات") || norm.contains("ارزش افزوده")) {
            val taxRegex = Regex("(?:مالیات|ارزش افزوده)\\s*(?:مبلغ)?\\s*([\\u0600-\\u06FF0-9\\s]+?)(?:تومان|ریال|،|$)")
            val taxM = taxRegex.find(norm)
            val parsedTax = taxM?.groupValues?.get(1)?.let { PersianUtils.parsePersianAmount(it) }
            if (parsedTax != null && parsedTax > 0) {
                tax = parsedTax
                if (totalAmount > tax) {
                    subtotal = totalAmount - tax
                }
            } else {
                // 10% standard VAT
                tax = (totalAmount * 10) / 110
                subtotal = totalAmount - tax
            }
        }

        // 6. Extract Category and Rules
        var categoryName = when (docType) {
            DocumentType.PURCHASE -> "خرید کالا و تجهیزات"
            DocumentType.SALE -> "فروش محصولات"
            DocumentType.EXPENSE -> "هزینه جاری"
            DocumentType.INCOME -> "درآمد و فروش خدمت"
            DocumentType.RECEIPT -> "دریافت وجوه"
            DocumentType.PAYMENT -> "پرداخت وجوه"
        }

        // Apply dynamic rules
        for (rule in rules) {
            if (norm.contains(rule.keyword, ignoreCase = true)) {
                categoryName = rule.suggestedCategoryName
                break
            }
        }

        // 7. Payment method
        val paymentMethod = when {
            norm.contains("چک") -> "چک صیادی"
            norm.contains("پایا") || norm.contains("ساتنا") || norm.contains("حواله") -> "حواله پایا / ساتنا"
            norm.contains("کارت به کارت") -> "کارت به کارت"
            norm.contains("کارتخوان") || norm.contains("پوز") -> "دستگاه پوز / کارتخوان"
            norm.contains("نقد") || norm.contains("دستی") -> "نقدی"
            else -> "نقدی / حواله"
        }

        // 8. Description
        val desc = if (norm.contains("بابت")) {
            norm.substringAfter("بابت").trim().take(120)
        } else {
            norm.take(100)
        }

        return StructuredExtraction(
            documentType = FieldExtraction(docType, confidence = 0.95f),
            contactName = FieldExtraction(contactMatch, confidence = contactConfidence, rawText = contactMatch),
            invoiceNumber = FieldExtraction(invoiceNumber, confidence = if (invoiceNumber != null) 0.95f else 0.4f, rawText = invoiceNumber),
            dateShamsi = FieldExtraction(dateShamsi, confidence = if (dateShamsi != null) 0.95f else 0.5f, rawText = dateShamsi),
            subtotal = FieldExtraction(subtotal, confidence = if (subtotal > 0) 0.92f else 0.4f),
            tax = FieldExtraction(tax, confidence = if (tax > 0) 0.88f else 0.95f),
            discount = FieldExtraction(discount, confidence = 0.95f),
            total = FieldExtraction(totalAmount, confidence = if (totalAmount > 0) 0.95f else 0.3f),
            description = FieldExtraction(desc, confidence = 0.90f),
            categoryName = FieldExtraction(categoryName, confidence = 0.92f),
            paymentMethod = FieldExtraction(paymentMethod, confidence = 0.90f),
            rawTranscript = transcript,
            source = source
        )
    }
}
