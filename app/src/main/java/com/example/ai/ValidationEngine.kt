package com.example.ai

import com.example.data.model.DocumentEntity
import com.example.data.model.IssueSeverity
import com.example.data.model.StructuredExtraction
import com.example.data.model.ValidationIssue
import com.example.data.model.ValidationReport

object ValidationEngine {

    fun validate(
        extraction: StructuredExtraction,
        existingDuplicates: List<DocumentEntity> = emptyList()
    ): ValidationReport {
        val issues = mutableListOf<ValidationIssue>()

        val total = extraction.total.value ?: 0L
        val subtotal = extraction.subtotal.value ?: 0L
        val tax = extraction.tax.value ?: 0L
        val discount = extraction.discount.value ?: 0L
        val contact = extraction.contactName.value
        val invoiceNum = extraction.invoiceNumber.value
        val date = extraction.dateShamsi.value

        // 1. Mandatory Fields Check
        var missingPrompt: String? = null

        if (total <= 0L) {
            issues.add(
                ValidationIssue(
                    field = "مبلغ کل",
                    message = "مبلغ فاکتور مشخص نشده است.",
                    severity = IssueSeverity.ERROR
                )
            )
            if (missingPrompt == null) missingPrompt = "مبلغ فاکتور چقدر است؟"
        }

        if (contact.isNullOrBlank()) {
            issues.add(
                ValidationIssue(
                    field = "طرف حساب",
                    message = "نام فروشنده یا خریدار در متن یافت نشد.",
                    severity = IssueSeverity.WARNING
                )
            )
            if (missingPrompt == null) missingPrompt = "طرف حساب یا فروشنده کیست؟"
        }

        if (invoiceNum.isNullOrBlank()) {
            issues.add(
                ValidationIssue(
                    field = "شماره فاکتور",
                    message = "شماره سند یا فاکتور ثبت نشده است.",
                    severity = IssueSeverity.INFO
                )
            )
        }

        if (date.isNullOrBlank()) {
            issues.add(
                ValidationIssue(
                    field = "تاریخ سند",
                    message = "تاریخ فاکتور تشخیص داده نشد؛ تاریخ امروز پیشنهاد می‌شود.",
                    severity = IssueSeverity.INFO
                )
            )
        }

        // 2. Mathematical Consistency Check
        val calculatedTotal = subtotal + tax - discount
        val isMathValid = if (total > 0 && (tax > 0 || discount > 0)) {
            val diff = Math.abs(calculatedTotal - total)
            if (diff > 500) {
                issues.add(
                    ValidationIssue(
                        field = "محاسبات ریاضی",
                        message = "مغایرت ریاضی: جمع جزء ($subtotal) + مالیات ($tax) - تخفیف ($discount) با جمع کل ($total) همخوانی ندارد.",
                        severity = IssueSeverity.WARNING
                    )
                )
                false
            } else {
                true
            }
        } else {
            true
        }

        // 3. Duplicate Invoice Warning
        val isDuplicateLikely = existingDuplicates.isNotEmpty()
        if (isDuplicateLikely) {
            val dup = existingDuplicates.first()
            issues.add(
                ValidationIssue(
                    field = "تکراری بودن",
                    message = "هشدار تکرار: سندی با همین شماره فاکتور (${dup.invoiceNumber}) و طرف حساب (${dup.contactName}) قبلاً در سیستم ثبت شده است!",
                    severity = IssueSeverity.WARNING
                )
            )
        }

        // Calculate confidence
        val hasError = issues.any { it.severity == IssueSeverity.ERROR }
        val hasWarning = issues.any { it.severity == IssueSeverity.WARNING }
        val overallConfidence = when {
            hasError -> 0.45f
            hasWarning -> 0.70f
            else -> 0.95f
        }

        return ValidationReport(
            issues = issues,
            isMathValid = isMathValid,
            isDuplicateLikely = isDuplicateLikely,
            hasMissingRequiredFields = contact.isNullOrBlank() || total <= 0L,
            overallConfidence = overallConfidence,
            promptForMissingField = missingPrompt
        )
    }
}
