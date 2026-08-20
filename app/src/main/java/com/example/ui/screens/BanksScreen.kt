package com.example.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.data.model.BankAccountEntity
import com.example.data.model.BankTransactionEntity
import com.example.data.model.DocumentEntity
import com.example.ui.theme.*
import com.example.util.PersianUtils

@Composable
fun BanksScreen(
    bankAccounts: List<BankAccountEntity>,
    bankTransactions: List<BankTransactionEntity>,
    documents: List<DocumentEntity>,
    onMatchTransaction: (Long, Long) -> Unit
) {
    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        item {
            Text("حساب‌های بانکی و تنخواه شرکتی", fontWeight = FontWeight.Bold, fontSize = 15.sp)
        }

        // Bank Account Cards
        items(bankAccounts) { acc ->
            Card(
                shape = RoundedCornerShape(14.dp),
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                elevation = CardDefaults.cardElevation(defaultElevation = 2.dp),
                modifier = Modifier.fillMaxWidth()
            ) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(16.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(12.dp)
                    ) {
                        Box(
                            modifier = Modifier
                                .size(44.dp)
                                .clip(CircleShape)
                                .background(StatusBlueBg),
                            contentAlignment = Alignment.Center
                        ) {
                            Icon(Icons.Default.AccountBalance, contentDescription = null, tint = StatusBlue)
                        }

                        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            Text(acc.bankName, fontWeight = FontWeight.Bold, fontSize = 14.sp)
                            Text(acc.accountName, fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            Text("شماره حساب: ${PersianUtils.toPersianDigits(acc.accountNumber)}", fontSize = 10.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }

                    Column(horizontalAlignment = Alignment.End) {
                        Text("موجودی دفتری:", fontSize = 10.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Text(
                            PersianUtils.formatPrice(acc.currentBalance),
                            fontWeight = FontWeight.Bold,
                            fontSize = 14.sp,
                            color = PrimaryEmerald
                        )
                    }
                }
            }
        }

        item {
            Text("مغایرت‌گیری و تطبیق صورت‌حساب بانکی (Bank Reconciliation):", fontWeight = FontWeight.Bold, fontSize = 14.sp)
        }

        // Bank Statement Rows with Smart Matching
        items(bankTransactions) { tx ->
            val isDeposit = tx.credit > 0
            val amount = if (isDeposit) tx.credit else tx.debit

            Card(
                shape = RoundedCornerShape(12.dp),
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                elevation = CardDefaults.cardElevation(defaultElevation = 1.dp),
                modifier = Modifier.fillMaxWidth()
            ) {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(14.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text(tx.description, fontWeight = FontWeight.Bold, fontSize = 13.sp)
                        Text(
                            (if (isDeposit) "+" else "-") + PersianUtils.formatPrice(amount),
                            fontWeight = FontWeight.Bold,
                            fontSize = 13.sp,
                            color = if (isDeposit) StatusGreen else StatusRed
                        )
                    }

                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text(
                            "تاریخ: ${PersianUtils.toPersianDigits(tx.dateShamsi)} • مانده: ${PersianUtils.formatPrice(tx.balance)}",
                            fontSize = 10.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )

                        if (tx.isReconciled) {
                            Surface(
                                color = StatusGreenBg,
                                shape = RoundedCornerShape(6.dp)
                            ) {
                                Text(
                                    "تطبیق داده شده ✓",
                                    color = StatusGreen,
                                    fontSize = 11.sp,
                                    fontWeight = FontWeight.Bold,
                                    modifier = Modifier.padding(horizontal = 8.dp, vertical = 3.dp)
                                )
                            }
                        } else {
                            val candidateDoc = documents.firstOrNull { it.total == amount }
                            if (candidateDoc != null) {
                                Button(
                                    onClick = { onMatchTransaction(tx.id, candidateDoc.id) },
                                    colors = ButtonDefaults.buttonColors(containerColor = PrimaryEmerald),
                                    shape = RoundedCornerShape(8.dp),
                                    contentPadding = PaddingValues(horizontal = 10.dp, vertical = 4.dp),
                                    modifier = Modifier.testTag("reconcile_match_btn_${tx.id}")
                                ) {
                                    Text("تطبیق با فاکتور «${candidateDoc.contactName}»", fontSize = 11.sp)
                                }
                            } else {
                                Surface(
                                    color = StatusYellowBg,
                                    shape = RoundedCornerShape(6.dp)
                                ) {
                                    Text(
                                        "فاقد سند متناظر",
                                        color = StatusYellowDark,
                                        fontSize = 11.sp,
                                        modifier = Modifier.padding(horizontal = 8.dp, vertical = 3.dp)
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
