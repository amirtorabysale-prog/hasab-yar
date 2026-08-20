package com.example.ui.screens

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.data.model.TransactionEntity
import com.example.data.model.TransactionType
import com.example.ui.components.EmptyStateView
import com.example.ui.components.MetricCard
import com.example.ui.theme.PrimaryEmerald
import com.example.ui.theme.StatusRed
import com.example.util.PersianUtils

@Composable
fun TransactionsScreen(
    transactions: List<TransactionEntity>,
    onAddTransaction: (TransactionType, Long, String, String, String) -> Unit
) {
    var showAddDialog by remember { mutableStateOf(false) }

    val totalExpense = transactions.filter { it.type == TransactionType.EXPENSE || it.type == TransactionType.PURCHASE }.sumOf { it.amount }
    val totalIncome = transactions.filter { it.type == TransactionType.INCOME || it.type == TransactionType.SALE || it.type == TransactionType.RECEIVE }.sumOf { it.amount }

    Scaffold(
        floatingActionButton = {
            FloatingActionButton(
                onClick = { showAddDialog = true },
                containerColor = PrimaryEmerald,
                contentColor = Color.White,
                modifier = Modifier.testTag("add_transaction_fab")
            ) {
                Icon(Icons.Default.Add, contentDescription = "ثبت تراکنش")
            }
        }
    ) { paddingValues ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(paddingValues)
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp)
        ) {
            // Metrics
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                MetricCard(
                    title = "مجموع واریز / دریافتی‌ها",
                    value = PersianUtils.formatPrice(totalIncome),
                    subtitle = "فروش و وصول مطالبات",
                    icon = Icons.Default.ArrowDownward,
                    accentColor = PrimaryEmerald,
                    modifier = Modifier.weight(1f)
                )
                MetricCard(
                    title = "مجموع برداشت / پرداخت‌ها",
                    value = PersianUtils.formatPrice(totalExpense),
                    subtitle = "خرید و هزینه‌های جاری",
                    icon = Icons.Default.ArrowUpward,
                    accentColor = StatusRed,
                    modifier = Modifier.weight(1f)
                )
            }

            // Transaction List
            Text("ریز تراکنش‌های ثبت‌شده در دفتر روزنامه:", fontWeight = FontWeight.Bold, fontSize = 14.sp)

            if (transactions.isEmpty()) {
                EmptyStateView(
                    icon = Icons.Default.SyncAlt,
                    title = "تراکنشی ثبت نشده است",
                    description = "تراکنش‌ها به صورت خودکار از فاکتورهای تأییدشده یا ثبت دستی افزوده می‌شوند."
                )
            } else {
                LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    verticalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    items(transactions) { tx ->
                        val isPositive = tx.type == TransactionType.INCOME || tx.type == TransactionType.SALE || tx.type == TransactionType.RECEIVE
                        Card(
                            shape = RoundedCornerShape(10.dp),
                            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                            elevation = CardDefaults.cardElevation(defaultElevation = 1.dp),
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(12.dp),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Row(
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(10.dp)
                                ) {
                                    Icon(
                                        imageVector = if (isPositive) Icons.Default.ArrowDownward else Icons.Default.ArrowUpward,
                                        contentDescription = null,
                                        tint = if (isPositive) PrimaryEmerald else StatusRed
                                    )
                                    Column {
                                        Text(tx.contactName.ifBlank { tx.categoryName }, fontWeight = FontWeight.Bold, fontSize = 13.sp)
                                        Text(tx.description, fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                        Text(PersianUtils.toPersianDigits(tx.dateShamsi), fontSize = 10.sp, color = MaterialTheme.colorScheme.outline)
                                    }
                                }

                                Text(
                                    text = (if (isPositive) "+ " else "- ") + PersianUtils.formatPrice(tx.amount),
                                    fontWeight = FontWeight.Bold,
                                    fontSize = 13.sp,
                                    color = if (isPositive) PrimaryEmerald else StatusRed
                                )
                            }
                        }
                    }
                }
            }
        }
    }

    if (showAddDialog) {
        var contact by remember { mutableStateOf("") }
        var amountStr by remember { mutableStateOf("") }
        var desc by remember { mutableStateOf("") }
        var cat by remember { mutableStateOf("هزینه جاری") }
        var type by remember { mutableStateOf(TransactionType.EXPENSE) }

        AlertDialog(
            onDismissRequest = { showAddDialog = false },
            title = { Text("ثبت دستی تراکنش مالی") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(
                        value = contact,
                        onValueChange = { contact = it },
                        label = { Text("طرف حساب") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth()
                    )
                    OutlinedTextField(
                        value = amountStr,
                        onValueChange = { amountStr = it },
                        label = { Text("مبلغ (تومان)") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth()
                    )
                    OutlinedTextField(
                        value = desc,
                        onValueChange = { desc = it },
                        label = { Text("شرح تراکنش") },
                        modifier = Modifier.fillMaxWidth()
                    )
                }
            },
            confirmButton = {
                Button(
                    onClick = {
                        val amount = PersianUtils.parsePersianAmount(amountStr) ?: 0L
                        if (amount > 0) {
                            onAddTransaction(type, amount, contact, desc, cat)
                            showAddDialog = false
                        }
                    },
                    colors = ButtonDefaults.buttonColors(containerColor = PrimaryEmerald)
                ) {
                    Text("ثبت تراکنش")
                }
            },
            dismissButton = {
                TextButton(onClick = { showAddDialog = false }) {
                    Text("انصراف")
                }
            }
        )
    }
}
