package com.example.ui.screens

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
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
import com.example.data.model.AccountPlan
import com.example.data.model.CompanyEntity
import com.example.data.model.UserRole
import com.example.ui.theme.PrimaryEmerald

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    activeCompany: CompanyEntity?,
    userRole: UserRole,
    accountPlan: AccountPlan,
    onRoleChange: (UserRole) -> Unit,
    onPlanChange: (AccountPlan) -> Unit
) {
    var aiConfidenceThreshold by remember { mutableStateOf(0.85f) }
    var enableContinuousSound by remember { mutableStateOf(true) }

    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp)
    ) {
        item {
            Text("تنظیمات سیستم و پروفایل اپراتوری:", fontWeight = FontWeight.Bold, fontSize = 15.sp)
        }

        // Active Company Info Card
        item {
            Card(
                shape = RoundedCornerShape(14.dp),
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                elevation = CardDefaults.cardElevation(defaultElevation = 1.dp),
                modifier = Modifier.fillMaxWidth()
            ) {
                Column(modifier = Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("مشخصات پرونده مالی فعال", fontWeight = FontWeight.Bold, fontSize = 13.sp)
                    Divider()
                    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text("نام شرکت:", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Text(activeCompany?.name ?: "نامشخص", fontWeight = FontWeight.SemiBold, fontSize = 12.sp)
                    }
                    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text("شناسه ملی:", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Text(activeCompany?.nationalId ?: "—", fontSize = 12.sp)
                    }
                    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text("واحد پول سامانه:", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Text(activeCompany?.currency ?: "تومان", fontSize = 12.sp)
                    }
                }
            }
        }

        // Role Switcher
        item {
            Card(
                shape = RoundedCornerShape(14.dp),
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                elevation = CardDefaults.cardElevation(defaultElevation = 1.dp),
                modifier = Modifier.fillMaxWidth()
            ) {
                Column(modifier = Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("سطح دسترسی و نقش کاربری:", fontWeight = FontWeight.Bold, fontSize = 13.sp)

                    UserRole.values().forEach { role ->
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.SpaceBetween
                        ) {
                            Text(role.titleFa, fontSize = 12.sp)
                            RadioButton(
                                selected = userRole == role,
                                onClick = { onRoleChange(role) },
                                colors = RadioButtonDefaults.colors(selectedColor = PrimaryEmerald),
                                modifier = Modifier.testTag("role_radio_${role.name.lowercase()}")
                            )
                        }
                    }
                }
            }
        }

        // AI Threshold Settings
        item {
            Card(
                shape = RoundedCornerShape(14.dp),
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                elevation = CardDefaults.cardElevation(defaultElevation = 1.dp),
                modifier = Modifier.fillMaxWidth()
            ) {
                Column(modifier = Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("تنظیمات موتور هوش مصنوعی و اعتبارسنجی:", fontWeight = FontWeight.Bold, fontSize = 13.sp)

                    Text(
                        text = "آستانه اطمینان خودکار: ${(aiConfidenceThreshold * 100).toInt()}٪",
                        fontSize = 12.sp
                    )
                    Slider(
                        value = aiConfidenceThreshold,
                        onValueChange = { aiConfidenceThreshold = it },
                        valueRange = 0.5f..0.98f,
                        steps = 5,
                        colors = SliderDefaults.colors(thumbColor = PrimaryEmerald, activeTrackColor = PrimaryEmerald)
                    )
                    Text(
                        text = "فاکتورهای با اطمینان کمتر از این درصد جهت بازبینی به صف «نیازمند بررسی» هدایت می‌شوند.",
                        fontSize = 10.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
        }
    }
}
