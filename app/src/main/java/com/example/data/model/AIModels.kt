package com.example.data.model

data class FieldExtraction<T>(
    val value: T?,
    val confidence: Float = 0.90f,
    val isUserEdited: Boolean = false,
    val rawText: String? = null
)

data class StructuredExtraction(
    val documentType: FieldExtraction<DocumentType> = FieldExtraction(DocumentType.PURCHASE),
    val contactName: FieldExtraction<String> = FieldExtraction(null),
    val invoiceNumber: FieldExtraction<String> = FieldExtraction(null),
    val dateShamsi: FieldExtraction<String> = FieldExtraction(null),
    val subtotal: FieldExtraction<Long> = FieldExtraction(0L),
    val tax: FieldExtraction<Long> = FieldExtraction(0L),
    val discount: FieldExtraction<Long> = FieldExtraction(0L),
    val total: FieldExtraction<Long> = FieldExtraction(0L),
    val description: FieldExtraction<String> = FieldExtraction(null),
    val categoryName: FieldExtraction<String> = FieldExtraction(null),
    val paymentMethod: FieldExtraction<String> = FieldExtraction("نقدی / حواله"),
    val rawTranscript: String = "",
    val source: DocumentSource = DocumentSource.VOICE
)

enum class IssueSeverity {
    INFO,
    WARNING,
    ERROR
}

data class ValidationIssue(
    val field: String,
    val message: String,
    val severity: IssueSeverity
)

data class ValidationReport(
    val issues: List<ValidationIssue> = emptyList(),
    val isMathValid: Boolean = true,
    val isDuplicateLikely: Boolean = false,
    val hasMissingRequiredFields: Boolean = false,
    val overallConfidence: Float = 0.92f,
    val promptForMissingField: String? = null
)

data class SpeechPreset(
    val id: String,
    val title: String,
    val transcript: String,
    val documentType: DocumentType,
    val audioSource: String = "صدای اپراتور"
)
