package com.example.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.data.model.CompanyEntity
import com.example.data.model.DocumentEntity
import com.example.ui.theme.PrimaryEmerald
import com.example.ui.theme.StatusGreen
import com.example.ui.theme.StatusGreenBg
import com.example.util.ExportUtils

@Composable
fun ExportScreen(
    documents: List<DocumentEntity>,
    activeCompany: CompanyEntity?
) {
    val companyName = activeCompany?.name ?: "پارس تجارت"
    val currency = activeCompany?.currency ?: "تومان"
    var exportResult by remember { mutableStateOf<String?>(null) }
    var exportTitle by remember { mutableStateOf<String?>(null) }

    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        item {
            Text("خروجی اسناد به نرم‌افزارهای حسابداری و مالیاتی", fontWeight = FontWeight.Bold, fontSize = 15.sp)
        }

        // Sepidar Export Card
        item {
            ExportFormatCard(
                title = "نرم‌افزار حسابداری سپیدار (Sepidar)",
                description = "تولید سند استاندارد حسابداری با کد حساب معین، کد تفصیلی و سطرهای بدهکار/بستانکار",
                icon = Icons.Default.CloudDownload,
                onExport = {
                    exportTitle = "خروجی سپیدار"
                    exportResult = ExportUtils.generateSepidarExport(documents, companyName)
                }
            )
        }

        // Holo Export Card
        item {
            ExportFormatCard(
                title = "نرم‌افزار هلو (Holo)",
                description = "خروجی استاندارد فاکتورها، طرف‌حساب‌ها، مالیات و تخفیف با جداکننده نقطه‌ویرگول (;)",
                icon = Icons.Default.Download,
                onExport = {
                    exportTitle = "خروجی هلو"
                    exportResult = ExportUtils.generateHoloExport(documents, companyName)
                }
            )
        }

        // Excel CSV Export Card
        item {
            ExportFormatCard(
                title = "فایل اکسل مایکروسافت (Excel / CSV با UTF-8 BOM)",
                description = "خروجی جامع شامل تمام فیلدهای تفکیکی، مبالغ، اقلام، وضعیت اعتبارسنجی و درصد اطمینان AI",
                icon = Icons.Default.TableChart,
                onExport = {
                    exportTitle = "خروجی اکسل استاندارد"
                    exportResult = ExportUtils.generateExcelCsv(documents, companyName)
                }
            )
        }

        // Text Financial Summary
        item {
            ExportFormatCard(
                title = "گزارش متنی جهت اشتراک در پیام‌رسان‌ها (واتساپ/بله/ایتا)",
                description = "خلاصه شکیل شاخص‌های مالی ماهانه جهت ارسال سریع به مدیرعامل یا هیئت‌مدیره",
                icon = Icons.Default.Share,
                onExport = {
                    exportTitle = "گزارش متنی مدیریت"
                    exportResult = ExportUtils.generateTextFinancialReport(documents, companyName, currency)
                }
            )
        }

        // Export Result Preview Box
        exportResult?.let { resultText ->
            item {
                Card(
                    shape = RoundedCornerShape(14.dp),
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                    elevation = CardDefaults.cardElevation(defaultElevation = 2.dp),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Column(
                        modifier = Modifier.padding(16.dp),
                        verticalArrangement = Arrangement.spacedBy(10.dp)
                    ) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp)
                        ) {
                            Icon(Icons.Default.CheckCircle, contentDescription = null, tint = StatusGreen)
                            Text(
                                text = "پیش‌نمایش ${exportTitle ?: "خروجی"}:",
                                fontWeight = FontWeight.Bold,
                                fontSize = 13.sp
                            )
                        }

                        Surface(
                            color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f),
                            shape = RoundedCornerShape(8.dp),
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            Text(
                                text = resultText,
                                fontSize = 11.sp,
                                modifier = Modifier.padding(12.dp),
                                lineHeight = 18.sp
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ExportFormatCard(
    title: String,
    description: String,
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    onExport: () -> Unit
) {
    Card(
        shape = RoundedCornerShape(12.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        elevation = CardDefaults.cardElevation(defaultElevation = 1.dp),
        modifier = Modifier.fillMaxWidth()
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(14.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Row(
                modifier = Modifier.weight(1f),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Box(
                    modifier = Modifier
                        .size(40.dp)
                        .clip(RoundedCornerShape(10.dp))
                        .background(PrimaryEmerald.copy(alpha = 0.12f)),
                    contentAlignment = Alignment.Center
                ) {
                    Icon(icon, contentDescription = null, tint = PrimaryEmerald)
                }

                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(title, fontWeight = FontWeight.Bold, fontSize = 13.sp)
                    Text(description, fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }

            Spacer(modifier = Modifier.width(8.dp))

            Button(
                onClick = onExport,
                colors = ButtonDefaults.buttonColors(containerColor = PrimaryEmerald),
                shape = RoundedCornerShape(8.dp),
                contentPadding = PaddingValues(horizontal = 12.dp, vertical = 6.dp)
            ) {
                Text("تولید فایل", fontSize = 11.sp)
            }
        }
    }
}
