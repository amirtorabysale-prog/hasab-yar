package com.example.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.data.model.DocumentSource
import com.example.data.model.DocumentStatus
import com.example.data.model.DocumentType
import com.example.data.model.IssueSeverity
import com.example.ui.components.*
import com.example.ui.theme.*
import com.example.ui.viewmodel.HesabYarViewModel
import com.example.util.PersianUtils

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FastEntryScreen(
    viewModel: HesabYarViewModel,
    onNavigateToDocuments: () -> Unit
) {
    val speechManager = viewModel.speechManager
    val isListening by speechManager.isListening.collectAsState()
    val transcript by speechManager.transcript.collectAsState()
    val audioAmplitude by speechManager.audioAmplitude.collectAsState()

    val extraction by viewModel.currentExtraction.collectAsState()
    val validationReport by viewModel.validationReport.collectAsState()
    val isAnalyzing by viewModel.isAnalyzing.collectAsState()
    val isContinuousMode by viewModel.isContinuousMode.collectAsState()
    val continuousStats by viewModel.continuousStats.collectAsState()
    val ocrPreview by viewModel.ocrSamplePreview.collectAsState()

    var customTextInput by remember { mutableStateOf("") }
    var showCustomTextDialog by remember { mutableStateOf(false) }

    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp)
    ) {
        // Continuous Operator Mode Header
        item {
            Card(
                shape = RoundedCornerShape(14.dp),
                colors = CardDefaults.cardColors(
                    containerColor = if (isContinuousMode) PrimaryEmerald.copy(alpha = 0.12f) else MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f)
                ),
                modifier = Modifier.fillMaxWidth()
            ) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(12.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Column {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(6.dp)
                        ) {
                            Icon(
                                imageVector = if (isContinuousMode) Icons.Default.Bolt else Icons.Default.Timer,
                                contentDescription = null,
                                tint = if (isContinuousMode) PrimaryEmerald else MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.size(18.dp)
                            )
                            Text(
                                text = "حالت اپراتور پیوسته (Continuous High-Speed Mode)",
                                fontWeight = FontWeight.Bold,
                                fontSize = 13.sp,
                                color = if (isContinuousMode) PrimaryEmerald else MaterialTheme.colorScheme.onSurface
                            )
                        }
                        if (isContinuousMode) {
                            Text(
                                text = "ثبت پیوسته اسناد • ${PersianUtils.toPersianDigits(continuousStats.totalProcessed.toString())} سند پردازش‌شده در این سشن",
                                fontSize = 11.sp,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        } else {
                            Text(
                                text = "برای ثبت سریع و متوالی ده‌ها فاکتور بدون کلیک مکرر فعال کنید",
                                fontSize = 11.sp,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                    }

                    Switch(
                        checked = isContinuousMode,
                        onCheckedChange = { viewModel.toggleContinuousMode() },
                        colors = SwitchDefaults.colors(checkedThumbColor = PrimaryEmerald, checkedTrackColor = PrimaryEmerald.copy(alpha = 0.4f)),
                        modifier = Modifier.testTag("continuous_mode_switch")
                    )
                }
            }
        }

        // Voice Input & Recording Centerpiece
        item {
            Card(
                shape = RoundedCornerShape(16.dp),
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                elevation = CardDefaults.cardElevation(defaultElevation = 2.dp),
                modifier = Modifier.fillMaxWidth()
            ) {
                Column(
                    modifier = Modifier.padding(16.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    Text(
                        text = if (isListening) "در حال شنیدن صدای اپراتور..." else "برای ثبت سند صوتی کلیک کنید",
                        fontWeight = FontWeight.Bold,
                        fontSize = 14.sp,
                        color = if (isListening) PrimaryEmerald else MaterialTheme.colorScheme.onSurface
                    )

                    AudioWaveformVisualizer(
                        isListening = isListening,
                        amplitude = audioAmplitude
                    )

                    // Big Voice Mic Button
                    Box(
                        modifier = Modifier
                            .size(72.dp)
                            .clip(CircleShape)
                            .background(if (isListening) StatusRed else PrimaryEmerald)
                            .clickable {
                                if (isListening) viewModel.stopVoiceRecording() else viewModel.startVoiceRecording()
                            }
                            .testTag("voice_record_button"),
                        contentAlignment = Alignment.Center
                    ) {
                        Icon(
                            imageVector = if (isListening) Icons.Default.Stop else Icons.Default.Mic,
                            contentDescription = "ضبط صدا",
                            tint = Color.White,
                            modifier = Modifier.size(36.dp)
                        )
                    }

                    // Live Transcript Box
                    if (transcript.isNotBlank()) {
                        Surface(
                            shape = RoundedCornerShape(8.dp),
                            color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.6f),
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            Text(
                                text = "متن شنیده‌شده: $transcript",
                                fontSize = 12.sp,
                                modifier = Modifier.padding(10.dp),
                                lineHeight = 18.sp
                            )
                        }
                    }

                    // OCR and Manual Input Alternative Actions
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceEvenly
                    ) {
                        OutlinedButton(
                            onClick = { showCustomTextDialog = true },
                            shape = RoundedCornerShape(20.dp)
                        ) {
                            Icon(Icons.Default.Keyboard, contentDescription = null, modifier = Modifier.size(16.dp))
                            Spacer(modifier = Modifier.width(4.dp))
                            Text("تایپ متن فاکتور", fontSize = 11.sp)
                        }

                        OutlinedButton(
                            onClick = { viewModel.setOcrPreview("فاکتور رسمی پارس رایانه") },
                            shape = RoundedCornerShape(20.dp)
                        ) {
                            Icon(Icons.Default.DocumentScanner, contentDescription = null, modifier = Modifier.size(16.dp))
                            Spacer(modifier = Modifier.width(4.dp))
                            Text("اسکن تصویر OCR", fontSize = 11.sp)
                        }
                    }
                }
            }
        }

        // Realistic Sample Presets for High-Speed Demonstration
        item {
            Text("نمونه‌های واقعی گفتار برای تست سریع:", fontSize = 12.sp, fontWeight = FontWeight.Bold)
            Spacer(modifier = Modifier.height(4.dp))
            LazyRow(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                modifier = Modifier.fillMaxWidth()
            ) {
                items(speechManager.samplePresets) { preset ->
                    SuggestionChip(
                        onClick = { viewModel.processPresetSpeech(preset) },
                        label = { Text(preset.title, fontSize = 11.sp) },
                        icon = { Icon(Icons.Default.PlayArrow, contentDescription = null, modifier = Modifier.size(14.dp), tint = PrimaryEmerald) },
                        modifier = Modifier.testTag("preset_chip_${preset.id}")
                    )
                }
            }
        }

        // OCR Sample Preview Badge (if activated)
        if (ocrPreview != null) {
            item {
                Surface(
                    shape = RoundedCornerShape(10.dp),
                    color = Color(0xFFE8EAF6),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Row(
                        modifier = Modifier.padding(10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.SpaceBetween
                    ) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Icon(Icons.Default.Image, contentDescription = null, tint = Color(0xFF3F51B5))
                            Text("تصویر بارگذاری شده: $ocrPreview", fontSize = 12.sp, color = Color(0xFF1A237E), fontWeight = FontWeight.SemiBold)
                        }
                        IconButton(onClick = { viewModel.clearOcrPreview() }, modifier = Modifier.size(24.dp)) {
                            Icon(Icons.Default.Close, contentDescription = "حذف تصویر", modifier = Modifier.size(16.dp))
                        }
                    }
                }
            }
        }

        // Structured AI Extraction Result Form
        item {
            Card(
                shape = RoundedCornerShape(16.dp),
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                elevation = CardDefaults.cardElevation(defaultElevation = 2.dp),
                modifier = Modifier
                    .fillMaxWidth()
                    .testTag("structured_extraction_card")
            ) {
                Column(
                    modifier = Modifier.padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    // Header with Confidence
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            Icon(Icons.Default.Analytics, contentDescription = null, tint = PrimaryEmerald)
                            Text("استخراج ساختاریافته هوشمند", fontWeight = FontWeight.Bold, fontSize = 14.sp)
                        }
                        ConfidenceBadge(confidence = validationReport.overallConfidence)
                    }

                    Divider()

                    // Validation Warnings / Math Mismatch Alerts
                    if (validationReport.issues.isNotEmpty()) {
                        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            validationReport.issues.forEach { issue ->
                                val (boxColor, textColor, icon) = when (issue.severity) {
                                    IssueSeverity.ERROR -> Triple(StatusRed.copy(alpha = 0.12f), StatusRed, Icons.Default.Error)
                                    IssueSeverity.WARNING -> Triple(StatusYellow.copy(alpha = 0.18f), StatusYellowDark, Icons.Default.Warning)
                                    IssueSeverity.INFO -> Triple(Color(0xFFE3F2FD), Color(0xFF1565C0), Icons.Default.Info)
                                }
                                Surface(
                                    shape = RoundedCornerShape(8.dp),
                                    color = boxColor,
                                    modifier = Modifier.fillMaxWidth()
                                ) {
                                    Row(
                                        modifier = Modifier.padding(8.dp),
                                        verticalAlignment = Alignment.CenterVertically,
                                        horizontalArrangement = Arrangement.spacedBy(6.dp)
                                    ) {
                                        Icon(icon, contentDescription = null, tint = textColor, modifier = Modifier.size(16.dp))
                                        Text(text = issue.message, fontSize = 11.sp, color = textColor, fontWeight = FontWeight.Medium)
                                    }
                                }
                            }
                        }
                    }

                    // Question for Missing Field (Active Learning / Clarification)
                    validationReport.promptForMissingField?.let { prompt ->
                        Surface(
                            shape = RoundedCornerShape(8.dp),
                            color = Color(0xFFEDE7F6),
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            Row(
                                modifier = Modifier.padding(10.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(8.dp)
                            ) {
                                Icon(Icons.Default.QuestionAnswer, contentDescription = null, tint = Color(0xFF512DA8))
                                Column {
                                    Text("پیشنهاد تکمیل خودکار:", fontSize = 11.sp, fontWeight = FontWeight.Bold, color = Color(0xFF512DA8))
                                    Text(prompt, fontSize = 12.sp, color = Color(0xFF311B92))
                                }
                            }
                        }
                    }

                    // Editable Fields Grid
                    OutlinedTextField(
                        value = extraction.contactName.value.orEmpty(),
                        onValueChange = { viewModel.updateField("contactName", it) },
                        label = { Text("نام طرف حساب / فروشنده *") },
                        leadingIcon = { Icon(Icons.Default.Person, contentDescription = null) },
                        singleLine = true,
                        modifier = Modifier
                            .fillMaxWidth()
                            .testTag("field_contact_name")
                    )

                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        OutlinedTextField(
                            value = extraction.invoiceNumber.value.orEmpty(),
                            onValueChange = { viewModel.updateField("invoiceNumber", it) },
                            label = { Text("شماره فاکتور") },
                            singleLine = true,
                            modifier = Modifier
                                .weight(1f)
                                .testTag("field_invoice_number")
                        )
                        OutlinedTextField(
                            value = extraction.dateShamsi.value ?: PersianUtils.getCurrentShamsiDate(),
                            onValueChange = { viewModel.updateField("dateShamsi", it) },
                            label = { Text("تاریخ سند") },
                            singleLine = true,
                            modifier = Modifier
                                .weight(1f)
                                .testTag("field_date_shamsi")
                        )
                    }

                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        OutlinedTextField(
                            value = if ((extraction.subtotal.value ?: 0L) > 0) extraction.subtotal.value.toString() else "",
                            onValueChange = { viewModel.updateField("subtotal", it) },
                            label = { Text("مبلغ جزء (تومان)") },
                            singleLine = true,
                            modifier = Modifier
                                .weight(1f)
                                .testTag("field_subtotal")
                        )
                        OutlinedTextField(
                            value = if ((extraction.tax.value ?: 0L) > 0) extraction.tax.value.toString() else "",
                            onValueChange = { viewModel.updateField("tax", it) },
                            label = { Text("مالیات (۱۰٪)") },
                            singleLine = true,
                            modifier = Modifier
                                .weight(1f)
                                .testTag("field_tax")
                        )
                    }

                    OutlinedTextField(
                        value = if ((extraction.total.value ?: 0L) > 0) extraction.total.value.toString() else "",
                        onValueChange = { viewModel.updateField("total", it) },
                        label = { Text("مبلغ کل نهایی (تومان) *") },
                        leadingIcon = { Icon(Icons.Default.AttachMoney, contentDescription = null) },
                        singleLine = true,
                        modifier = Modifier
                            .fillMaxWidth()
                            .testTag("field_total")
                    )

                    OutlinedTextField(
                        value = extraction.categoryName.value.orEmpty(),
                        onValueChange = { viewModel.updateField("categoryName", it) },
                        label = { Text("سرفصل حسابداری") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth()
                    )

                    OutlinedTextField(
                        value = extraction.description.value.orEmpty(),
                        onValueChange = { viewModel.updateField("description", it) },
                        label = { Text("شرح سند و اقلام") },
                        maxLines = 2,
                        modifier = Modifier.fillMaxWidth()
                    )

                    // Action Buttons
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        Button(
                            onClick = {
                                viewModel.saveDocument(DocumentStatus.APPROVED) {
                                    // if not continuous, navigate to docs
                                    if (!isContinuousMode) onNavigateToDocuments()
                                }
                            },
                            colors = ButtonDefaults.buttonColors(containerColor = PrimaryEmerald),
                            shape = RoundedCornerShape(10.dp),
                            modifier = Modifier
                                .weight(1.2f)
                                .testTag("approve_save_btn")
                        ) {
                            Icon(Icons.Default.Check, contentDescription = null, modifier = Modifier.size(16.dp))
                            Spacer(modifier = Modifier.width(6.dp))
                            Text("تأیید نهایی و ثبت", fontWeight = FontWeight.Bold, fontSize = 13.sp)
                        }

                        OutlinedButton(
                            onClick = {
                                viewModel.saveDocument(DocumentStatus.NEEDS_REVIEW) {
                                    if (!isContinuousMode) onNavigateToDocuments()
                                }
                            },
                            shape = RoundedCornerShape(10.dp),
                            modifier = Modifier
                                .weight(1f)
                                .testTag("save_as_review_btn")
                        ) {
                            Text("ذخیره با نقص", fontSize = 12.sp)
                        }
                    }
                }
            }
        }
    }

    // Custom Text Input Dialog
    if (showCustomTextDialog) {
        AlertDialog(
            onDismissRequest = { showCustomTextDialog = false },
            title = { Text("تایپ متن یا شرح فاکتور") },
            text = {
                OutlinedTextField(
                    value = customTextInput,
                    onValueChange = { customTextInput = it },
                    placeholder = { Text("مثال: فاکتور خرید لپتاپ از شرکت پارس رایانه مبلغ ۱۲۰ میلیون تومان...") },
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(120.dp),
                    maxLines = 5
                )
            },
            confirmButton = {
                Button(
                    onClick = {
                        if (customTextInput.isNotBlank()) {
                            viewModel.processCustomTranscript(customTextInput, DocumentSource.MANUAL)
                            showCustomTextDialog = false
                            customTextInput = ""
                        }
                    },
                    colors = ButtonDefaults.buttonColors(containerColor = PrimaryEmerald)
                ) {
                    Text("پردازش هوشمند")
                }
            },
            dismissButton = {
                TextButton(onClick = { showCustomTextDialog = false }) {
                    Text("انصراف")
                }
            }
        )
    }
}
