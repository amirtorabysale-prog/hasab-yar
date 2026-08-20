package com.example.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
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
import androidx.compose.ui.window.Dialog
import com.example.data.model.AuditLogEntity
import com.example.data.model.DocumentEntity
import com.example.data.model.DocumentStatus
import com.example.ui.theme.*
import com.example.util.PersianUtils

@Composable
fun CreateCompanyDialog(
    onDismiss: () -> Unit,
    onConfirm: (name: String, activity: String, nationalId: String, city: String, desc: String) -> Unit
) {
    var name by remember { mutableStateOf("") }
    var activity by remember { mutableStateOf("بازرگانی و خدمات") }
    var nationalId by remember { mutableStateOf("") }
    var city by remember { mutableStateOf("تهران") }
    var desc by remember { mutableStateOf("") }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                Icon(Icons.Default.AddBusiness, contentDescription = null, tint = PrimaryEmerald)
                Text("تعریف شرکت / پرونده مالی جدید", fontWeight = FontWeight.Bold, fontSize = 16.sp)
            }
        },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it },
                    label = { Text("نام شرکت یا فروشگاه *") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )
                OutlinedTextField(
                    value = activity,
                    onValueChange = { activity = it },
                    label = { Text("نوع فعالیت (بازرگانی، تولیدی، خدماتی)") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )
                OutlinedTextField(
                    value = nationalId,
                    onValueChange = { nationalId = it },
                    label = { Text("شناسه ملی / کد اقتصادی") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )
                OutlinedTextField(
                    value = city,
                    onValueChange = { city = it },
                    label = { Text("شهر محل فعالیت") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )
            }
        },
        confirmButton = {
            Button(
                onClick = {
                    if (name.isNotBlank()) {
                        onConfirm(name, activity, nationalId, city, desc)
                        onDismiss()
                    }
                },
                colors = ButtonDefaults.buttonColors(containerColor = PrimaryEmerald)
            ) {
                Text("ایجاد پرونده مالی")
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text("انصراف")
            }
        }
    )
}

@Composable
fun DuplicateWarningDialog(
    duplicateDoc: DocumentEntity,
    onDismiss: () -> Unit,
    onViewExisting: () -> Unit,
    onForceSave: () -> Unit
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                Icon(Icons.Default.WarningAmber, contentDescription = null, tint = StatusYellowDark)
                Text("هشدار فاکتور تکراری!", fontWeight = FontWeight.Bold, fontSize = 16.sp)
            }
        },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    text = "سندی با شماره «${duplicateDoc.invoiceNumber}» و طرف حساب «${duplicateDoc.contactName}» به مبلغ «${PersianUtils.formatPrice(duplicateDoc.total)}» قبلاً در سیستم ثبت شده است.",
                    fontSize = 13.sp,
                    lineHeight = 20.sp
                )
                Text(
                    text = "آیا می‌خواهید سند ثبت‌شده قبلی را باز کنید یا این سند را به عنوان فاکتور مجزا ذخیره نمایید؟",
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        },
        confirmButton = {
            Button(
                onClick = onViewExisting,
                colors = ButtonDefaults.buttonColors(containerColor = PrimaryEmerald),
                modifier = Modifier.testTag("view_existing_dup_btn")
            ) {
                Text("مشاهده سند قبلی")
            }
        },
        dismissButton = {
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                TextButton(onClick = onDismiss) {
                    Text("انصراف")
                }
                TextButton(onClick = onForceSave) {
                    Text("ثبت به هر حال", color = StatusYellowDark)
                }
            }
        }
    )
}

@Composable
fun DocumentDetailModal(
    document: DocumentEntity,
    auditLogs: List<AuditLogEntity>,
    onClose: () -> Unit,
    onStatusChange: (DocumentStatus) -> Unit
) {
    Dialog(onDismissRequest = onClose) {
        Surface(
            modifier = Modifier
                .fillMaxWidth()
                .padding(8.dp),
            shape = RoundedCornerShape(16.dp),
            color = MaterialTheme.colorScheme.surface
        ) {
            Column(
                modifier = Modifier.padding(20.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp)
            ) {
                // Header
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        DocumentTypeBadge(type = document.type)
                        Text(
                            text = "سند شماره ${document.invoiceNumber}",
                            fontWeight = FontWeight.Bold,
                            fontSize = 15.sp
                        )
                    }
                    IconButton(onClick = onClose) {
                        Icon(Icons.Default.Close, contentDescription = "بستن")
                    }
                }

                Divider()

                // Info Rows
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text("طرف حساب:", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(document.contactName.ifBlank { "نامشخص" }, fontWeight = FontWeight.Bold, fontSize = 13.sp)
                }
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text("تاریخ فاکتور:", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(PersianUtils.toPersianDigits(document.dateShamsi), fontSize = 12.sp)
                }
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text("سرفصل حسابداری:", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(document.categoryName, fontSize = 12.sp)
                }
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text("نحوه تسویه:", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(document.paymentMethod, fontSize = 12.sp)
                }

                Surface(
                    color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f),
                    shape = RoundedCornerShape(8.dp),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Column(modifier = Modifier.padding(10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            Text("مبلغ جزء (پایه):", fontSize = 11.sp)
                            Text(PersianUtils.formatPrice(document.subtotal), fontSize = 11.sp)
                        }
                        if (document.tax > 0) {
                            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                Text("مالیات بر ارزش افزوده:", fontSize = 11.sp, color = StatusRed)
                                Text("+ ${PersianUtils.formatPrice(document.tax)}", fontSize = 11.sp, color = StatusRed)
                            }
                        }
                        Divider()
                        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            Text("مبلغ کل سند:", fontWeight = FontWeight.Bold, fontSize = 13.sp)
                            Text(PersianUtils.formatPrice(document.total), fontWeight = FontWeight.Bold, fontSize = 14.sp, color = PrimaryEmerald)
                        }
                    }
                }

                // Status Modifier Action
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceEvenly
                ) {
                    Button(
                        onClick = { onStatusChange(DocumentStatus.APPROVED) },
                        colors = ButtonDefaults.buttonColors(containerColor = PrimaryEmerald),
                        modifier = Modifier.weight(1f)
                    ) {
                        Text("تأیید نهایی سند", fontSize = 12.sp)
                    }
                    Spacer(modifier = Modifier.width(8.dp))
                    OutlinedButton(
                        onClick = { onStatusChange(DocumentStatus.NEEDS_REVIEW) },
                        modifier = Modifier.weight(1f)
                    ) {
                        Text("نیاز به بررسی", fontSize = 12.sp)
                    }
                }

                // Audit Logs Section
                Text("لاگ تغییرات و تاریخچه ممیزی:", fontSize = 12.sp, fontWeight = FontWeight.Bold)
                LazyColumn(
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(max = 120.dp),
                    verticalArrangement = Arrangement.spacedBy(4.dp)
                ) {
                    if (auditLogs.isEmpty()) {
                        item {
                            Text("هنوز لاگی برای این سند ثبت نشده است.", fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    } else {
                        items(auditLogs) { log ->
                            Surface(
                                shape = RoundedCornerShape(6.dp),
                                color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.3f),
                                modifier = Modifier.fillMaxWidth()
                            ) {
                                Row(
                                    modifier = Modifier.padding(6.dp),
                                    horizontalArrangement = Arrangement.SpaceBetween,
                                    verticalAlignment = Alignment.CenterVertically
                                ) {
                                    Column {
                                        Text("${log.userName}: ${log.action}", fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
                                        Text(log.detail, fontSize = 10.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
