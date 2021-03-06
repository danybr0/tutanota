// @flow
import {AccountType, OperationType, GroupType} from "../common/TutanotaConstants"
import {load, loadRoot} from "./Entity"
import {neverNull} from "../common/utils/Utils"
import {CustomerTypeRef} from "../entities/sys/Customer"
import {UserTypeRef} from "../entities/sys/User"
import {isSameTypeRef, isSameId} from "../common/EntityFunctions"
import {GroupInfoTypeRef} from "../entities/sys/GroupInfo"
import {assertMainOrNode} from "../Env"
import {TutanotaPropertiesTypeRef} from "../entities/tutanota/TutanotaProperties"

assertMainOrNode()

export class UserController {
	user: User;
	userGroupInfo: GroupInfo;
	props: TutanotaProperties;
	sessionElementId: Id;

	constructor(user: User, userGroupInfo: GroupInfo, sessionElementId: Id, props: TutanotaProperties) {
		this.user = user
		this.userGroupInfo = userGroupInfo
		this.props = props
		this.sessionElementId = sessionElementId
	}

	/**
	 * Checks if the current user is an admin of the customer.
	 * @return True if the user is an admin
	 */
	isAdmin() {
		if (this.isInternalUser()) {
			return this.user.memberships.find(m => m.admin) != null
		} else {
			return false;
		}
	}

	/**
	 * Checks if the account type of the logged in user is FREE.
	 * @returns True if the account type is FREE otherwise false
	 */
	isFreeAccount(): boolean {
		return this.user.accountType === AccountType.FREE
	}


	isPremiumAccount(): boolean {
		return this.user.accountType === AccountType.PREMIUM
	}

	isOutlookAccount(): boolean {
		return this.user.accountType === AccountType.STARTER
	}

	/**
	 * Provides the information if an internal user is logged in.
	 * @return True if an internal user is logged in, false if no user or an external user is logged in.
	 */
	isInternalUser(): boolean {
		return this.user.accountType !== AccountType.EXTERNAL
	}

	loadCustomer(): Promise<Customer> {
		return load(CustomerTypeRef, neverNull(this.user.customer))
	}


	getMailGroupMemberships(): GroupMembership[] {
		return this.user.memberships.filter(membership => membership.groupType == GroupType.Mail)
	}

	getUserMailGroupMembership(): GroupMembership {
		return this.getMailGroupMemberships()[0]
	}

	entityEventReceived(typeRef: TypeRef<any>, listId: ?string, elementId: string, operation: OperationTypeEnum) {
		if (operation == OperationType.UPDATE && isSameTypeRef(typeRef, UserTypeRef) && isSameId(this.user._id, elementId)) {
			load(UserTypeRef, this.user._id).then(updatedUser => {
				this.user = updatedUser
			})
		} else if (operation == OperationType.UPDATE && isSameTypeRef(typeRef, GroupInfoTypeRef) && isSameId(this.userGroupInfo._id, [neverNull(listId), elementId])) {
			load(GroupInfoTypeRef, this.userGroupInfo._id).then(updatedUserGroupInfo => {
				this.userGroupInfo = updatedUserGroupInfo
			})
		} else if (isSameTypeRef(typeRef, TutanotaPropertiesTypeRef) && operation == OperationType.UPDATE) {
			loadRoot(TutanotaPropertiesTypeRef, this.user.userGroup.group).then(props => {
				this.props = props
			})
		}
	}
}
