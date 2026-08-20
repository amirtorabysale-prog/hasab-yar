package com.example.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import com.example.data.model.BankAccountEntity
import com.example.data.model.CompanyEntity
import com.example.data.model.DocumentEntity
import com.example.data.model.DocumentStatus
import com.example.data.model.DocumentType
import com.example.data.model.TransactionEntity
import com.example.ui.components.*
import com.example.ui.theme.*
import com.example.util.PersianUtils

@Composable
fun DashboardScreen(
    documents: List<DocumentEntity>,
    transactions: List<TransactionEntity>,
    bankAccounts: List<BankAccountEntity>,
    activeCompany: CompanyEntity?,
    onNavigateToFastEntry: () -> Unit,
    onNavigateToDocuments: () -> Unit,
    onSelectDocument: (DocumentEntity) -> Unit
) {
    val currency = activeCompany?.currency ?: "تومان"

    val approvedCount = documents.count { it.status == DocumentStatus.APPROVED }
    val needsReviewCount = documents.count { it.status == DocumentStatus.NEEDS_REVIEW }
    val totalPurchases = documents.filter { it.type == DocumentType.PURCHASE }.sumOf { it.total }
    val totalSales = documents.filter { it.type == DocumentType.SALE }.sumOf { it.total }
    val totalExpenses = documents.filter { it.type == DocumentType.EXPENSE }.sumOf { it.total }
    val totalBankBalance = bankAccounts.sumOf { it.currentBalance }

    val recentDocs = documents.take(5)
    val needsReviewDocs = documents.filter { it.status == DocumentStatus.NEEDS_REVIEW }

    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp)
    ) {
        // Hero Action Card (Fast Entry Callout)
        item {
            Card(
                shape = RoundedCornerShape(16.dp),
                colors = CardDefaults.cardColors(containerColor = PrimaryEmerald),
                modifier = Modifier
                    .fillMaxWidth()
                    .testTag("fast_entry_hero_card")
            ) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(18.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween
                ) {
                    Column(
                        modifier = Modifier.weight(1f),
                        verticalArrangement = Arrangement.spacedBy(4.dp)
                    ) {
                        Text(
                            text = "ورود هوشمند فاکتور و اسناد مالی",
                            color = Color.White,
                            fontWeight = FontWeight.Bold,
                            fontSize = 16.sp
                        )
                        Text(
                            text = "ثبت صوتی چندثانیه‌ای + اسکن OCR + استخراج ساختاریافته بدون اشتباه",
                            color = Color.White.copy(alpha = 0.85f),
                            fontSize = 11.sp
                        )
                        Spacer(modifier = Modifier.height(4.dp))
                        Button(
                            onClick = onNavigateToFastEntry,
                            colors = ButtonDefaults.buttonColors(
                                containerColor = Color.White,
                                contentColor = PrimaryEmerald
                            ),
                            shape = RoundedCornerShape(20.dp),
                            contentPadding = PaddingValues(horizontal = 14.dp, vertical = 6.dp),
                            modifier = Modifier.testTag("start_fast_entry_btn")
                        ) {
                            Icon(Icons.Default.Mic, contentDescription = null, modifier = Modifier.size(16.dp))
                            Spacer(modifier = Modifier.width(6.dp))
                            Text("شروع ثبت سریع (صوت / تصویر)", fontSize = 12.sp, fontWeight = FontWeight.Bold)
                        }
                    }
                    Box(
                        modifier = Modifier
                            .size(60.dp)
                            .clip(CircleShape)
                            .background(Color.White.copy(alpha = 0.15f)),
                        contentAlignment = Alignment.Center
                    ) {
                        Icon(
                            imageVector = Icons.Default.AutoAwesome,
                            contentDescription = null,
                            tint = Color.White,
                            modifier = Modifier.size(32.dp)
                        )
                    }
                }
            }
        }

        // Needs Review Warning Banner (if any)
        if (needsReviewCount > 0) {
            item {
                Card(
                    shape = RoundedCornerShape(12.dp),
                    colors = CardDefaults.cardColors(containerColor = StatusYellow.copy(alpha = 0.15f)),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.SpaceBetween
                    ) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp)
                        ) {
                            Icon(Icons.Default.WarningAmber, contentDescription = null, tint = StatusYellowDark)
                            Column {
                                Text(
                                    text = "${PersianUtils.toPersianDigits(needsReviewCount.toString())} سند نیازمند بررسی و تأیید است",
                                    fontWeight = FontWeight.Bold,
                                    fontSize = 13.sp,
                                    color = StatusYellowDark
                                )
                                Text(
                                    text = "دارای کسری اطلاعات طرف حساب یا مغایرت محاسباتی",
                                    fontSize = 11.sp,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant
                                )
                            }
                        }
                        TextButton(onClick = onNavigateToDocuments) {
                            Text("مشاهده اسناد", color = StatusYellowDark, fontSize = 12.sp, fontWeight = FontWeight.Bold)
                        }
                    }
                }
            }
        }

        // Key KPI Metrics Grid
        item {
            Text("خلاصه وضعیت مالی و اپراتوری", fontWeight = FontWeight.Bold, fontSize = 14.sp)
        }

        item {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                MetricCard(
                    title = "کل اسناد ثبت‌شده",
                    value = "${PersianUtils.toPersianDigits(documents.size.toString())} سند",
                    subtitle = "${PersianUtils.toPersianDigits(approvedCount.toString())} تأییدشده",
                    icon = Icons.Default.ReceiptLong,
                    accentColor = PrimaryEmerald,
                    modifier = Modifier.weight(1f)
                )
                MetricCard(
                    title = "موجودی کل بانک‌ها",
                    value = PersianUtils.formatPrice(totalBankBalance, currency),
                    subtitle = "${PersianUtils.toPersianDigits(bankAccounts.size.toString())} حساب فعال",
                    icon = Icons.Default.AccountBalance,
                    accentColor = Color(0xFF1976D2),
                    modifier = Modifier.weight(1f)
                )
            }
        }

        item {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                MetricCard(
                    title = "مجموع خرید کالا",
                    value = PersianUtils.formatPrice(totalPurchases, currency),
                    subtitle = "تجهیزات و ملزومات",
                    icon = Icons.Default.ShoppingCart,
                    accentColor = Color(0xFF673AB7),
                    modifier = Modifier.weight(1f)
                )
                MetricCard(
                    title = "مجموع هزینه‌های جاری",
                    value = PersianUtils.formatPrice(totalExpenses, currency),
                    subtitle = "سوخت، اینترنت، کرایه",
                    icon = Icons.Default.MoneyOff,
                    accentColor = StatusRed,
                    modifier = Modifier.weight(1f)
                )
            }
        }

        // Recent Documents List Section
        item {
            SectionHeader(
                title = "آخرین اسناد و فاکتورهای ثبتی",
                actionText = "مشاهده همه (${PersianUtils.toPersianDigits(documents.size.toString())})",
                onActionClick = onNavigateToDocuments
            )
        }

        if (recentDocs.isEmpty()) {
            item {
                EmptyStateView(
                    icon = Icons.Default.ReceiptLong,
                    title = "هنوز سندی ثبت نشده است",
                    description = "با دکمه ورود سریع، اولین فاکتور را به راحتی با صوت یا اسکن ثبت نمایید."
                )
            }
        } else {
            items(recentDocs) { doc ->
                Card(
                    shape = RoundedCornerShape(12.dp),
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                    elevation = CardDefaults.cardElevation(defaultElevation = 1.dp),
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable { onSelectDocument(doc) }
                        .testTag("doc_item_${doc.id}")
                ) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(14.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.SpaceBetween
                    ) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(10.dp)
                        ) {
                            Box(
                                modifier = Modifier
                                    .size(38.dp)
                                    .clip(RoundedCornerShape(8.dp))
                                    .background(
                                        when (doc.type) {
                                            DocumentType.PURCHASE -> Color(0xFFEDE7F6)
                                            DocumentType.SALE -> Color(0xFFE8F5E9)
                                            else -> Color(0xFFFFEBEE)
                                        }
                                    ),
                                contentAlignment = Alignment.Center
                            ) {
                                Icon(
                                    imageVector = when (doc.type) {
                                        DocumentType.PURCHASE -> Icons.Default.ShoppingCart
                                        DocumentType.SALE -> Icons.Default.Store
                                        else -> Icons.Default.Receipt
                                    },
                                    contentDescription = null,
                                    tint = when (doc.type) {
                                        DocumentType.PURCHASE -> Color(0xFF512DA8)
                                        DocumentType.SALE -> Color(0xFF2E7D32)
                                        else -> Color(0xFFC62828)
                                    },
                                    modifier = Modifier.size(20.dp)
                                )
                            }

                            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                Text(
                                    text = doc.contactName.ifBlank { "طرف‌حساب نامشخص" },
                                    fontWeight = FontWeight.Bold,
                                    fontSize = 13.sp
                                )
                                Text(
                                    text = "فاکتور ${doc.invoiceNumber} • ${PersianUtils.toPersianDigits(doc.dateShamsi)}",
                                    fontSize = 11.sp,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant
                                )
                            }
                        }

                        Column(
                            horizontalAlignment = Alignment.End,
                            verticalArrangement = Arrangement.spacedBy(4.dp)
                        ) {
                            Text(
                                text = PersianUtils.formatPrice(doc.total, currency),
                                fontWeight = FontWeight.Bold,
                                fontSize = 13.sp,
                                color = MaterialTheme.colorScheme.onSurface
                            )
                            DocumentStatusBadge(status = doc.status)
                        }
                    }
                }
            }
        }
    }
}
