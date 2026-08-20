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
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.data.model.ContactEntity
import com.example.data.model.ContactType
import com.example.data.model.DocumentEntity
import com.example.ui.components.EmptyStateView
import com.example.ui.theme.PrimaryEmerald
import com.example.ui.theme.StatusRed
import com.example.util.PersianUtils

@Composable
fun ContactsScreen(
    contacts: List<ContactEntity>,
    documents: List<DocumentEntity>,
    onAddContact: (String, String, ContactType, String) -> Unit
) {
    var searchQuery by remember { mutableStateOf("") }
    var showAddDialog by remember { mutableStateOf(false) }

    val filteredContacts = contacts.filter {
        searchQuery.isBlank() || it.name.contains(searchQuery, ignoreCase = true) || it.phone.contains(searchQuery)
    }

    Scaffold(
        floatingActionButton = {
            FloatingActionButton(
                onClick = { showAddDialog = true },
                containerColor = PrimaryEmerald,
                contentColor = androidx.compose.ui.graphics.Color.White,
                modifier = Modifier.testTag("add_contact_fab")
            ) {
                Icon(Icons.Default.PersonAdd, contentDescription = "افزودن طرف حساب")
            }
        }
    ) { paddingValues ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(paddingValues)
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            OutlinedTextField(
                value = searchQuery,
                onValueChange = { searchQuery = it },
                placeholder = { Text("جستجوی نام فروشنده، مشتری یا شماره تماس...", fontSize = 12.sp) },
                leadingIcon = { Icon(Icons.Default.Search, contentDescription = null) },
                singleLine = true,
                shape = RoundedCornerShape(12.dp),
                modifier = Modifier.fillMaxWidth()
            )

            if (filteredContacts.isEmpty()) {
                EmptyStateView(
                    icon = Icons.Default.People,
                    title = "طرف حسابی یافت نشد",
                    description = "می‌توانید اشخاص و شرکت‌های طرف معامله را اضافه کنید."
                )
            } else {
                LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    verticalArrangement = Arrangement.spacedBy(10.dp)
                ) {
                    items(filteredContacts) { contact ->
                        val docCount = documents.count { it.contactName == contact.name }
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
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(10.dp)
                                ) {
                                    Icon(
                                        imageVector = when (contact.type) {
                                            ContactType.VENDOR -> Icons.Default.Store
                                            ContactType.CUSTOMER -> Icons.Default.ShoppingBag
                                            ContactType.EMPLOYEE -> Icons.Default.Badge
                                            else -> Icons.Default.Person
                                        },
                                        contentDescription = null,
                                        tint = PrimaryEmerald
                                    )
                                    Column {
                                        Text(contact.name, fontWeight = FontWeight.Bold, fontSize = 14.sp)
                                        Text(
                                            text = "${contact.type.titleFa} • ${contact.phone.ifBlank { "بدون تلفن" }}",
                                            fontSize = 11.sp,
                                            color = MaterialTheme.colorScheme.onSurfaceVariant
                                        )
                                        Text(
                                            text = "${PersianUtils.toPersianDigits(docCount.toString())} سند و فاکتور ثبت‌شده",
                                            fontSize = 10.sp,
                                            color = MaterialTheme.colorScheme.outline
                                        )
                                    }
                                }

                                Column(horizontalAlignment = Alignment.End) {
                                    Text(
                                        text = if (contact.balance >= 0) "بستانکار" else "بدهکار",
                                        fontSize = 10.sp,
                                        color = if (contact.balance >= 0) PrimaryEmerald else StatusRed
                                    )
                                    Text(
                                        text = PersianUtils.formatPrice(Math.abs(contact.balance)),
                                        fontWeight = FontWeight.Bold,
                                        fontSize = 13.sp,
                                        color = if (contact.balance >= 0) PrimaryEmerald else StatusRed
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    if (showAddDialog) {
        var name by remember { mutableStateOf("") }
        var phone by remember { mutableStateOf("") }
        var notes by remember { mutableStateOf("") }
        var type by remember { mutableStateOf(ContactType.VENDOR) }

        AlertDialog(
            onDismissRequest = { showAddDialog = false },
            title = { Text("تعریف طرف حساب جدید") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(
                        value = name,
                        onValueChange = { name = it },
                        label = { Text("نام شخص یا شرکت *") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth()
                    )
                    OutlinedTextField(
                        value = phone,
                        onValueChange = { phone = it },
                        label = { Text("شماره تماس") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth()
                    )
                    OutlinedTextField(
                        value = notes,
                        onValueChange = { notes = it },
                        label = { Text("توضیحات و زمینه کاری") },
                        modifier = Modifier.fillMaxWidth()
                    )
                }
            },
            confirmButton = {
                Button(
                    onClick = {
                        if (name.isNotBlank()) {
                            onAddContact(name, phone, type, notes)
                            showAddDialog = false
                        }
                    },
                    colors = ButtonDefaults.buttonColors(containerColor = PrimaryEmerald)
                ) {
                    Text("ذخیره طرف حساب")
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
